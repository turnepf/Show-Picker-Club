// WebAuthn / passkey verification, hand-rolled against WebCrypto.
//
// There is no build step in this repo (see CLAUDE.md), so the usual npm
// WebAuthn libraries aren't available — everything a relying party actually
// has to do is here: decode the CBOR the authenticator sends, turn the COSE
// public key inside it into a CryptoKey, and check the signature. The Workers
// runtime supplies crypto.subtle, atob/btoa and TextDecoder, which is all of
// the primitives this needs.
//
// Scope is deliberately narrow: registration accepts only self-attestation or
// no attestation ("none"/"packed" without a certificate chain), which is what
// Apple's platform authenticator sends and all we want anyway — we trust the
// device because the member was already signed in when they enrolled it, not
// because a manufacturer certificate says so. Verifying an attestation chain
// would mean shipping root certificates we have no way to keep current.

// ---- base64url ----

export function bytesToB64url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  // String.fromCharCode.apply blows the stack on large inputs; chunk it.
  for (let i = 0; i < arr.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s) {
  let t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = t.length % 4;
  if (pad) t += '='.repeat(4 - pad);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomChallenge(byteLength = 32) {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

// Constant-time-ish comparison for the short strings we compare (challenges).
// Not a defence against a local attacker — it just avoids handing out timing
// signal on a value an attacker supplies.
export function safeEqual(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// ---- minimal CBOR ----
//
// Enough of RFC 8949 to read an attestation object and a COSE key: unsigned
// and negative integers, byte and text strings, arrays, maps, and the three
// simple values. Definite lengths only — authenticators emit canonical CBOR,
// and refusing anything else keeps the parser small. Returns { value, offset }
// so the caller can tell where the COSE key inside authenticatorData ended.

function cborRead(buf, offset) {
  if (offset >= buf.length) throw new Error('cbor_truncated');
  const initial = buf[offset++];
  const major = initial >> 5;
  const minor = initial & 0x1f;

  let length = minor;
  if (minor === 24) { length = buf[offset]; offset += 1; }
  else if (minor === 25) { length = (buf[offset] << 8) | buf[offset + 1]; offset += 2; }
  else if (minor === 26) {
    length = ((buf[offset] << 24) >>> 0) + (buf[offset + 1] << 16) + (buf[offset + 2] << 8) + buf[offset + 3];
    offset += 4;
  } else if (minor === 27) {
    // 64-bit lengths: read as a Number. Anything this large is malformed for
    // our inputs, and Number is exact below 2^53.
    let n = 0;
    for (let i = 0; i < 8; i++) n = n * 256 + buf[offset + i];
    length = n;
    offset += 8;
  } else if (minor > 27) {
    throw new Error('cbor_bad_minor');
  }

  switch (major) {
    case 0: // unsigned int
      return { value: length, offset };
    case 1: // negative int
      return { value: -1 - length, offset };
    case 2: { // byte string
      if (offset + length > buf.length) throw new Error('cbor_truncated');
      return { value: buf.slice(offset, offset + length), offset: offset + length };
    }
    case 3: { // text string
      if (offset + length > buf.length) throw new Error('cbor_truncated');
      const text = new TextDecoder().decode(buf.subarray(offset, offset + length));
      return { value: text, offset: offset + length };
    }
    case 4: { // array
      const arr = [];
      for (let i = 0; i < length; i++) {
        const item = cborRead(buf, offset);
        arr.push(item.value);
        offset = item.offset;
      }
      return { value: arr, offset };
    }
    case 5: { // map
      const map = new Map();
      for (let i = 0; i < length; i++) {
        const k = cborRead(buf, offset);
        const v = cborRead(buf, k.offset);
        map.set(k.value, v.value);
        offset = v.offset;
      }
      return { value: map, offset };
    }
    case 7: // simple values
      if (minor === 20) return { value: false, offset };
      if (minor === 21) return { value: true, offset };
      if (minor === 22) return { value: null, offset };
      throw new Error('cbor_unsupported_simple');
    default:
      throw new Error('cbor_unsupported_major');
  }
}

export function cborDecode(bytes) {
  return cborRead(bytes, 0).value;
}

// ---- COSE keys ----

const COSE_KTY = 1;
const COSE_ALG = 3;
const COSE_CRV = -1;
const COSE_EC_X = -2;
const COSE_EC_Y = -3;
const COSE_RSA_N = -1;
const COSE_RSA_E = -2;

const ALG_ES256 = -7;
const ALG_RS256 = -257;

// A COSE key as CBOR bytes -> a CryptoKey that can verify a WebAuthn
// signature, plus the verify parameters for it. ES256 is what Apple's
// platform authenticator produces; RS256 is here so a hardware key that only
// does RSA still works.
export async function coseToVerifyKey(coseBytes) {
  const key = cborDecode(coseBytes);
  if (!(key instanceof Map)) throw new Error('cose_not_a_map');

  const kty = key.get(COSE_KTY);
  const alg = key.get(COSE_ALG);

  if (kty === 2 && alg === ALG_ES256) {
    if (key.get(COSE_CRV) !== 1) throw new Error('cose_unsupported_curve');
    const x = key.get(COSE_EC_X);
    const y = key.get(COSE_EC_Y);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array)) throw new Error('cose_bad_ec_point');
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: bytesToB64url(x), y: bytesToB64url(y), ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return { cryptoKey, params: { name: 'ECDSA', hash: 'SHA-256' }, alg: ALG_ES256 };
  }

  if (kty === 3 && alg === ALG_RS256) {
    const n = key.get(COSE_RSA_N);
    const e = key.get(COSE_RSA_E);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) throw new Error('cose_bad_rsa_key');
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: bytesToB64url(n), e: bytesToB64url(e), alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return { cryptoKey, params: { name: 'RSASSA-PKCS1-v1_5' }, alg: ALG_RS256 };
  }

  throw new Error('cose_unsupported_algorithm');
}

// WebAuthn ECDSA signatures are DER-encoded (SEQUENCE of two INTEGERs);
// WebCrypto wants the raw r||s pair, each left-padded to the curve size.
function derToRawEcdsa(der) {
  if (der[0] !== 0x30) throw new Error('sig_not_der');
  // Skip SEQUENCE tag and length (short or long form).
  let i = 1;
  if (der[i] & 0x80) i += 1 + (der[i] & 0x7f); else i += 1;

  const readInt = () => {
    if (der[i] !== 0x02) throw new Error('sig_not_integer');
    i += 1;
    let len = der[i];
    i += 1;
    let value = der.slice(i, i + len);
    i += len;
    // DER integers are signed, so a high bit means a 0x00 was prepended.
    while (value.length > 32 && value[0] === 0x00) value = value.slice(1);
    if (value.length > 32) throw new Error('sig_component_too_long');
    const padded = new Uint8Array(32);
    padded.set(value, 32 - value.length);
    return padded;
  };

  const r = readInt();
  const s = readInt();
  const raw = new Uint8Array(64);
  raw.set(r, 0);
  raw.set(s, 32);
  return raw;
}

// ---- authenticator data ----

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_CREDENTIAL = 0x40;

export function parseAuthenticatorData(bytes) {
  if (bytes.length < 37) throw new Error('authdata_too_short');
  const rpIdHash = bytes.slice(0, 32);
  const flags = bytes[32];
  const signCount = (bytes[33] << 24 >>> 0) + (bytes[34] << 16) + (bytes[35] << 8) + bytes[36];

  const parsed = {
    rpIdHash,
    flags,
    signCount,
    userPresent: !!(flags & FLAG_USER_PRESENT),
    userVerified: !!(flags & FLAG_USER_VERIFIED),
    credentialId: null,
    credentialPublicKey: null,
    aaguid: null,
  };

  if (flags & FLAG_ATTESTED_CREDENTIAL) {
    if (bytes.length < 55) throw new Error('authdata_missing_credential');
    parsed.aaguid = bytes.slice(37, 53);
    const idLength = (bytes[53] << 8) | bytes[54];
    const idEnd = 55 + idLength;
    if (bytes.length < idEnd) throw new Error('authdata_truncated_credential_id');
    parsed.credentialId = bytes.slice(55, idEnd);
    // The COSE key runs to the end of the buffer unless extension data
    // follows; cborRead tells us where it actually stopped.
    const { offset } = cborRead(bytes, idEnd);
    parsed.credentialPublicKey = bytes.slice(idEnd, offset);
  }

  return parsed;
}

// ---- shared checks ----

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Validates the client data blob common to registration and authentication.
// Returns the raw bytes (needed for the signature) on success; throws with a
// short machine-readable reason otherwise.
function checkClientData(clientDataJSON, { type, expectedChallenge, allowedOrigins }) {
  const raw = b64urlToBytes(clientDataJSON);
  let data;
  try {
    data = JSON.parse(new TextDecoder().decode(raw));
  } catch (e) {
    throw new Error('client_data_not_json');
  }
  if (data.type !== type) throw new Error('client_data_wrong_type');
  if (!safeEqual(data.challenge, expectedChallenge)) throw new Error('challenge_mismatch');
  if (!allowedOrigins.includes(data.origin)) throw new Error('origin_mismatch');
  return raw;
}

/**
 * Verify a registration (navigator.credentials.create / ASAuthorization
 * platform credential registration). Returns the credential to store.
 */
export async function verifyRegistration({
  attestationObject,
  clientDataJSON,
  expectedChallenge,
  rpId,
  allowedOrigins,
}) {
  checkClientData(clientDataJSON, {
    type: 'webauthn.create',
    expectedChallenge,
    allowedOrigins,
  });

  const attestation = cborDecode(b64urlToBytes(attestationObject));
  if (!(attestation instanceof Map)) throw new Error('attestation_not_a_map');
  const authData = attestation.get('authData');
  if (!(authData instanceof Uint8Array)) throw new Error('attestation_missing_authdata');

  const parsed = parseAuthenticatorData(authData);
  if (!bytesEqual(parsed.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) {
    throw new Error('rp_id_mismatch');
  }
  if (!parsed.userPresent) throw new Error('user_not_present');
  // We ask for userVerification: "required", so anything without the UV flag
  // didn't do what we asked and shouldn't become a login credential.
  if (!parsed.userVerified) throw new Error('user_not_verified');
  if (!parsed.credentialId || !parsed.credentialPublicKey) throw new Error('no_attested_credential');

  // Rejects a key we could never verify a login with, at enrollment time
  // rather than the first time the member tries to sign in with it.
  await coseToVerifyKey(parsed.credentialPublicKey);

  return {
    credentialId: bytesToB64url(parsed.credentialId),
    publicKey: bytesToB64url(parsed.credentialPublicKey),
    signCount: parsed.signCount,
    aaguid: bytesToB64url(parsed.aaguid),
    fmt: attestation.get('fmt') || 'none',
  };
}

/**
 * Verify an assertion (navigator.credentials.get / ASAuthorization platform
 * credential assertion). Returns { signCount } for the caller to persist.
 */
export async function verifyAssertion({
  authenticatorData,
  clientDataJSON,
  signature,
  publicKey,
  expectedChallenge,
  rpId,
  allowedOrigins,
  storedSignCount = 0,
}) {
  const clientDataBytes = checkClientData(clientDataJSON, {
    type: 'webauthn.get',
    expectedChallenge,
    allowedOrigins,
  });

  const authDataBytes = b64urlToBytes(authenticatorData);
  const parsed = parseAuthenticatorData(authDataBytes);
  if (!bytesEqual(parsed.rpIdHash, await sha256(new TextEncoder().encode(rpId)))) {
    throw new Error('rp_id_mismatch');
  }
  if (!parsed.userPresent) throw new Error('user_not_present');
  if (!parsed.userVerified) throw new Error('user_not_verified');

  const { cryptoKey, params, alg } = await coseToVerifyKey(b64urlToBytes(publicKey));

  // The signed payload is authenticatorData || SHA-256(clientDataJSON).
  const clientDataHash = await sha256(clientDataBytes);
  const signed = new Uint8Array(authDataBytes.length + clientDataHash.length);
  signed.set(authDataBytes, 0);
  signed.set(clientDataHash, authDataBytes.length);

  let sigBytes = b64urlToBytes(signature);
  if (alg === ALG_ES256) sigBytes = derToRawEcdsa(sigBytes);

  const ok = await crypto.subtle.verify(params, cryptoKey, sigBytes, signed);
  if (!ok) throw new Error('bad_signature');

  // Cloned-authenticator check. Apple's passkeys always report 0 and never
  // increment, so this can only be enforced when both sides are non-zero —
  // treating 0 as a rollback would lock out every Apple device.
  if (storedSignCount > 0 && parsed.signCount > 0 && parsed.signCount <= storedSignCount) {
    throw new Error('sign_count_rollback');
  }

  return { signCount: parsed.signCount };
}
