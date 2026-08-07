// Unit tests for functions/_shared/webauthn.js — the hand-rolled passkey
// verification the login path depends on.
//
//   node scripts/webauthn-test.mjs
//
// Everything a real authenticator sends is simulated here with WebCrypto:
// COSE public keys, CBOR attestation objects, DER-encoded ECDSA signatures.
// Both directions are covered — a valid credential must verify, and every
// way of forging one (another key, another origin, another relying party, a
// replayed challenge, a rolled-back counter, a skipped biometric) must not.
//
// No network, no dependencies, deterministic: safe for the PR gate.
//
// The repo deliberately has no package.json (see CLAUDE.md — a build step is
// exactly what this stack avoids, and Pages would try to run one), so Node
// treats the module's .js as CommonJS and its `export`s won't load. Copying
// the source to a .mjs in a temp dir is what makes it importable; the bytes
// under test are the real ones.

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const copy = join(mkdtempSync(join(tmpdir(), 'webauthn-test-')), 'webauthn.mjs');
writeFileSync(copy, readFileSync(join(repoRoot, 'functions/_shared/webauthn.js')));

const {
  verifyRegistration, verifyAssertion, bytesToB64url, b64urlToBytes,
  parseAuthenticatorData, cborDecode, coseToVerifyKey,
} = await import(copy);

const RP_ID = 'showpicker.club';
const ORIGIN = 'https://showpicker.club';
const ORIGINS = [ORIGIN];

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}
async function expectThrows(name, fn, wanted) {
  try {
    await fn();
    failed++; console.log(`  FAIL ${name} — expected a rejection, got success`);
  } catch (e) {
    const match = !wanted || e.message === wanted;
    if (match) { passed++; console.log(`  ok   ${name} (${e.message})`); }
    else { failed++; console.log(`  FAIL ${name} — wanted "${wanted}", got "${e.message}"`); }
  }
}

// ---- minimal CBOR encoder (test-side only) ----

function head(major, length) {
  if (length < 24) return Uint8Array.from([(major << 5) | length]);
  if (length < 256) return Uint8Array.from([(major << 5) | 24, length]);
  if (length < 65536) return Uint8Array.from([(major << 5) | 25, length >> 8, length & 0xff]);
  return Uint8Array.from([(major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]);
}
function cat(...chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
function cborEncode(value) {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (value instanceof Uint8Array) return cat(head(2, value.length), value);
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value);
    return cat(head(3, bytes.length), bytes);
  }
  if (Array.isArray(value)) return cat(head(4, value.length), ...value.map(cborEncode));
  if (value instanceof Map) {
    return cat(head(5, value.size), ...[...value].map(([k, v]) => cat(cborEncode(k), cborEncode(v))));
  }
  throw new Error('test encoder: unsupported ' + typeof value);
}

// ---- authenticator simulation ----

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

function coseFromEcJwk(jwk) {
  return cborEncode(new Map([
    [1, 2], [3, -7], [-1, 1],
    [-2, b64urlToBytes(jwk.x)],
    [-3, b64urlToBytes(jwk.y)],
  ]));
}
function coseFromRsaJwk(jwk) {
  return cborEncode(new Map([
    [1, 3], [3, -257],
    [-1, b64urlToBytes(jwk.n)],
    [-2, b64urlToBytes(jwk.e)],
  ]));
}

// flags: UP=0x01, UV=0x04, AT=0x40
async function makeAuthData({ rpId = RP_ID, flags, signCount = 0, credentialId, cose }) {
  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  const counter = Uint8Array.from([
    (signCount >>> 24) & 0xff, (signCount >> 16) & 0xff, (signCount >> 8) & 0xff, signCount & 0xff,
  ]);
  let out = cat(rpIdHash, Uint8Array.from([flags]), counter);
  if (flags & 0x40) {
    const aaguid = new Uint8Array(16).fill(7);
    const idLen = Uint8Array.from([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]);
    out = cat(out, aaguid, idLen, credentialId, cose);
  }
  return out;
}

function clientData({ type, challenge, origin = ORIGIN }) {
  return bytesToB64url(new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

// WebCrypto signs ECDSA as raw r||s; real authenticators emit DER. Convert so
// the module's DER handling is what's under test.
function rawToDer(raw) {
  const trim = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = cat(Uint8Array.from([0]), v);
    return v;
  };
  const r = trim(raw.slice(0, 32));
  const s = trim(raw.slice(32, 64));
  const body = cat(Uint8Array.from([0x02, r.length]), r, Uint8Array.from([0x02, s.length]), s);
  return cat(Uint8Array.from([0x30, body.length]), body);
}

async function signAssertion(privateKey, authData, clientDataB64, { rsa = false } = {}) {
  const hash = await sha256(b64urlToBytes(clientDataB64));
  const signed = cat(authData, hash);
  if (rsa) {
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, signed));
    return bytesToB64url(sig);
  }
  const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, signed));
  return bytesToB64url(rawToDer(raw));
}

// ---- tests ----

console.log('\n== base64url round trip');
{
  const bytes = crypto.getRandomValues(new Uint8Array(200));
  check('round trips arbitrary bytes', bytesToB64url(b64urlToBytes(bytesToB64url(bytes))) === bytesToB64url(bytes));
  check('emits no padding or +/', !/[+/=]/.test(bytesToB64url(bytes)));
  const big = new Uint8Array(200000).fill(65);
  check('handles a large buffer without blowing the stack', bytesToB64url(big).length > 0);
}

console.log('\n== CBOR decoding');
{
  check('unsigned ints across width boundaries', (() => {
    for (const n of [0, 23, 24, 255, 256, 65535, 65536, 4294967295]) {
      if (cborDecode(cborEncode(n)) !== n) return false;
    }
    return true;
  })());
  check('negative ints', cborDecode(cborEncode(-7)) === -7 && cborDecode(cborEncode(-257)) === -257);
  check('text and nested structures', (() => {
    const m = cborDecode(cborEncode(new Map([['a', [1, 2, 3]], ['b', 'hi']])));
    return m.get('b') === 'hi' && m.get('a')[2] === 3;
  })());
}

console.log('\n== ES256 registration');
const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const ecJwk = await crypto.subtle.exportKey('jwk', ec.publicKey);
const credentialId = crypto.getRandomValues(new Uint8Array(32));
const cose = coseFromEcJwk(ecJwk);
const regChallenge = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));

async function attestationFor(authData) {
  return bytesToB64url(cborEncode(new Map([
    ['fmt', 'none'], ['attStmt', new Map()], ['authData', authData],
  ])));
}

let stored;
{
  const authData = await makeAuthData({ flags: 0x01 | 0x04 | 0x40, credentialId, cose });
  const cdj = clientData({ type: 'webauthn.create', challenge: regChallenge });
  stored = await verifyRegistration({
    attestationObject: await attestationFor(authData),
    clientDataJSON: cdj,
    expectedChallenge: regChallenge,
    rpId: RP_ID,
    allowedOrigins: ORIGINS,
  });
  check('accepts a well-formed registration', stored.credentialId === bytesToB64url(credentialId));
  check('extracts the COSE public key', b64urlToBytes(stored.publicKey).length === cose.length);
  check('records the aaguid', b64urlToBytes(stored.aaguid).length === 16);
}

console.log('\n== registration rejections');
{
  const authData = await makeAuthData({ flags: 0x01 | 0x04 | 0x40, credentialId, cose });
  const att = await attestationFor(authData);
  const base = { attestationObject: att, expectedChallenge: regChallenge, rpId: RP_ID, allowedOrigins: ORIGINS };

  await expectThrows('rejects a mismatched challenge', () => verifyRegistration({
    ...base, clientDataJSON: clientData({ type: 'webauthn.create', challenge: bytesToB64url(new Uint8Array(32)) }),
  }), 'challenge_mismatch');

  await expectThrows('rejects a foreign origin', () => verifyRegistration({
    ...base, clientDataJSON: clientData({ type: 'webauthn.create', challenge: regChallenge, origin: 'https://evil.example' }),
  }), 'origin_mismatch');

  await expectThrows('rejects a get-type clientData', () => verifyRegistration({
    ...base, clientDataJSON: clientData({ type: 'webauthn.get', challenge: regChallenge }),
  }), 'client_data_wrong_type');

  const wrongRp = await makeAuthData({ rpId: 'evil.example', flags: 0x01 | 0x04 | 0x40, credentialId, cose });
  await expectThrows('rejects another relying party', async () => verifyRegistration({
    ...base, attestationObject: await attestationFor(wrongRp),
    clientDataJSON: clientData({ type: 'webauthn.create', challenge: regChallenge }),
  }), 'rp_id_mismatch');

  const noUv = await makeAuthData({ flags: 0x01 | 0x40, credentialId, cose });
  await expectThrows('rejects an unverified user', async () => verifyRegistration({
    ...base, attestationObject: await attestationFor(noUv),
    clientDataJSON: clientData({ type: 'webauthn.create', challenge: regChallenge }),
  }), 'user_not_verified');

  const noAt = await makeAuthData({ flags: 0x01 | 0x04 });
  await expectThrows('rejects authData carrying no credential', async () => verifyRegistration({
    ...base, attestationObject: await attestationFor(noAt),
    clientDataJSON: clientData({ type: 'webauthn.create', challenge: regChallenge }),
  }), 'no_attested_credential');
}

console.log('\n== ES256 assertion');
const authChallenge = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));
{
  const authData = await makeAuthData({ flags: 0x01 | 0x04 });
  const cdj = clientData({ type: 'webauthn.get', challenge: authChallenge });
  const signature = await signAssertion(ec.privateKey, authData, cdj);
  const result = await verifyAssertion({
    authenticatorData: bytesToB64url(authData),
    clientDataJSON: cdj,
    signature,
    publicKey: stored.publicKey,
    expectedChallenge: authChallenge,
    rpId: RP_ID,
    allowedOrigins: ORIGINS,
    storedSignCount: 0,
  });
  check('accepts a valid DER-signed assertion', result.signCount === 0);
}

console.log('\n== assertion rejections');
{
  const authData = await makeAuthData({ flags: 0x01 | 0x04 });
  const cdj = clientData({ type: 'webauthn.get', challenge: authChallenge });
  const good = await signAssertion(ec.privateKey, authData, cdj);
  const base = {
    authenticatorData: bytesToB64url(authData), clientDataJSON: cdj,
    publicKey: stored.publicKey, expectedChallenge: authChallenge,
    rpId: RP_ID, allowedOrigins: ORIGINS,
  };

  const other = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const forged = await signAssertion(other.privateKey, authData, cdj);
  await expectThrows('rejects a signature from another key', () => verifyAssertion({ ...base, signature: forged }), 'bad_signature');

  // Flip a byte inside the DER signature's s component.
  const tampered = b64urlToBytes(good);
  tampered[tampered.length - 1] ^= 0xff;
  await expectThrows('rejects a tampered signature', () => verifyAssertion({ ...base, signature: bytesToB64url(tampered) }));

  await expectThrows('rejects a replayed challenge value', () => verifyAssertion({
    ...base, signature: good, expectedChallenge: bytesToB64url(new Uint8Array(32)),
  }), 'challenge_mismatch');

  const evilCdj = clientData({ type: 'webauthn.get', challenge: authChallenge, origin: 'https://evil.example' });
  await expectThrows('rejects a foreign origin', async () => verifyAssertion({
    ...base, clientDataJSON: evilCdj, signature: await signAssertion(ec.privateKey, authData, evilCdj),
  }), 'origin_mismatch');

  const wrongRp = await makeAuthData({ rpId: 'evil.example', flags: 0x01 | 0x04 });
  await expectThrows('rejects another relying party', async () => verifyAssertion({
    ...base, authenticatorData: bytesToB64url(wrongRp),
    signature: await signAssertion(ec.privateKey, wrongRp, cdj),
  }), 'rp_id_mismatch');

  const noUv = await makeAuthData({ flags: 0x01 });
  await expectThrows('rejects an unverified user', async () => verifyAssertion({
    ...base, authenticatorData: bytesToB64url(noUv),
    signature: await signAssertion(ec.privateKey, noUv, cdj),
  }), 'user_not_verified');

  const noUp = await makeAuthData({ flags: 0x04 });
  await expectThrows('rejects an absent user', async () => verifyAssertion({
    ...base, authenticatorData: bytesToB64url(noUp),
    signature: await signAssertion(ec.privateKey, noUp, cdj),
  }), 'user_not_present');
}

console.log('\n== signature counter');
{
  const cdj = clientData({ type: 'webauthn.get', challenge: authChallenge });
  const mk = async (count, storedCount) => {
    const authData = await makeAuthData({ flags: 0x01 | 0x04, signCount: count });
    return verifyAssertion({
      authenticatorData: bytesToB64url(authData), clientDataJSON: cdj,
      signature: await signAssertion(ec.privateKey, authData, cdj),
      publicKey: stored.publicKey, expectedChallenge: authChallenge,
      rpId: RP_ID, allowedOrigins: ORIGINS, storedSignCount: storedCount,
    });
  };
  check('accepts an increasing counter', (await mk(9, 5)).signCount === 9);
  // Apple's authenticator always reports 0 — the check must not fire there.
  check('accepts Apple\'s always-zero counter', (await mk(0, 0)).signCount === 0);
  await expectThrows('rejects a counter rollback (cloned key)', () => mk(3, 9), 'sign_count_rollback');
}

console.log('\n== RS256 (hardware key fallback)');
{
  const rsa = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', rsa.publicKey);
  const rsaCose = coseFromRsaJwk(jwk);
  const rsaCredId = crypto.getRandomValues(new Uint8Array(32));
  const challenge = bytesToB64url(crypto.getRandomValues(new Uint8Array(32)));

  const regAuth = await makeAuthData({ flags: 0x01 | 0x04 | 0x40, credentialId: rsaCredId, cose: rsaCose });
  const reg = await verifyRegistration({
    attestationObject: await attestationFor(regAuth),
    clientDataJSON: clientData({ type: 'webauthn.create', challenge }),
    expectedChallenge: challenge, rpId: RP_ID, allowedOrigins: ORIGINS,
  });
  check('registers an RS256 credential', reg.credentialId === bytesToB64url(rsaCredId));

  const authData = await makeAuthData({ flags: 0x01 | 0x04 });
  const cdj = clientData({ type: 'webauthn.get', challenge });
  const result = await verifyAssertion({
    authenticatorData: bytesToB64url(authData), clientDataJSON: cdj,
    signature: await signAssertion(rsa.privateKey, authData, cdj, { rsa: true }),
    publicKey: reg.publicKey, expectedChallenge: challenge,
    rpId: RP_ID, allowedOrigins: ORIGINS, storedSignCount: 0,
  });
  check('verifies an RS256 assertion', result.signCount === 0);
}

console.log('\n== unsupported algorithms are refused');
{
  const ed = cborEncode(new Map([[1, 1], [3, -8], [-1, 6], [-2, new Uint8Array(32)]]));
  await expectThrows('refuses an EdDSA COSE key', () => coseToVerifyKey(ed), 'cose_unsupported_algorithm');
  const p384 = cborEncode(new Map([[1, 2], [3, -7], [-1, 2], [-2, new Uint8Array(48)], [-3, new Uint8Array(48)]]));
  await expectThrows('refuses a non-P-256 curve', () => coseToVerifyKey(p384), 'cose_unsupported_curve');
}

console.log('\n== malformed input is refused, not crashed on');
{
  await expectThrows('truncated attestation object', () => verifyRegistration({
    attestationObject: bytesToB64url(Uint8Array.from([0xa3, 0x63])),
    clientDataJSON: clientData({ type: 'webauthn.create', challenge: regChallenge }),
    expectedChallenge: regChallenge, rpId: RP_ID, allowedOrigins: ORIGINS,
  }));
  await expectThrows('clientData that is not JSON', async () => verifyRegistration({
    attestationObject: bytesToB64url(cborEncode(new Map([['authData', new Uint8Array(64)]]))),
    clientDataJSON: bytesToB64url(new TextEncoder().encode('not json')),
    expectedChallenge: regChallenge, rpId: RP_ID, allowedOrigins: ORIGINS,
  }), 'client_data_not_json');
  check('parseAuthenticatorData refuses a short buffer', (() => {
    try { parseAuthenticatorData(new Uint8Array(10)); return false; } catch (e) { return e.message === 'authdata_too_short'; }
  })());
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAILED'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
