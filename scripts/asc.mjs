#!/usr/bin/env node
// App Store Connect operator tool.
//
// Reads and updates the app's version records without going through the web
// UI. Written for the release run sheet in docs/APP_STORE_SUBMISSION.md §6a,
// where three platforms need the same What's New text and the same build
// attached, and doing that by hand is three chances to let them drift.
//
// Credentials are deliberately NOT in this repo. The private key lives at
// ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 and the issuer id comes
// from $ASC_ISSUER_ID or ~/.appstoreconnect/issuer_id.
//
//   node scripts/asc.mjs status
//   node scripts/asc.mjs set-notes 1.4.1 <file>
//   node scripts/asc.mjs upload <path-to-.ipa-or-.pkg>
//   node scripts/asc.mjs attach 1.4.1 24
//
// There is deliberately no `submit` subcommand: sending a version to review is
// a person's decision, made in the web UI.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const KEY_DIR = path.join(os.homedir(), '.appstoreconnect', 'private_keys');

// The key id was hardcoded to the development Mac's key, which meant every
// other machine died on "No private key at .../AuthKey_<that key>.p8" while
// holding a perfectly good key of its own. Read the directory instead: one
// key is the normal case and needs no configuration, and ASC_KEY_ID still
// wins when a machine holds several.
function resolveKeyId() {
  if (process.env.ASC_KEY_ID) return process.env.ASC_KEY_ID.trim();
  let found = [];
  try {
    found = fs.readdirSync(KEY_DIR)
      .map(f => /^AuthKey_(.+)\.p8$/.exec(f)?.[1])
      .filter(Boolean);
  } catch { /* no directory yet — fall through to the error below */ }
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    die(`Several keys in ${KEY_DIR} (${found.join(', ')}). Set ASC_KEY_ID to pick one.`);
  }
  die(`No API key in ${KEY_DIR}. Download one from App Store Connect → Users and Access → Integrations.`);
}

const KEY_ID = resolveKeyId();
const APP_ID = process.env.ASC_APP_ID || '6780282764';
const API = 'https://api.appstoreconnect.apple.com';

function issuerId() {
  if (process.env.ASC_ISSUER_ID) return process.env.ASC_ISSUER_ID.trim();
  const f = path.join(os.homedir(), '.appstoreconnect', 'issuer_id');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  die(`No issuer id. Set ASC_ISSUER_ID or write it to ${f}`);
}

function privateKey() {
  const f = path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${KEY_ID}.p8`);
  if (!fs.existsSync(f)) die(`No private key at ${f}`);
  return fs.readFileSync(f);
}

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

// Apple rejects the default DER encoding; ES256 here must be raw r||s.
function token() {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
  const body = b64({ iss: issuerId(), iat: now, exp: now + 900, aud: 'appstoreconnect-v1' });
  const data = `${head}.${body}`;
  const sig = crypto.sign('sha256', Buffer.from(data), { key: privateKey(), dsaEncoding: 'ieee-p1363' });
  return `${data}.${sig.toString('base64url')}`;
}

async function call(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return {};
  const text = await res.text();
  if (!res.ok) die(`${method} ${endpoint} -> ${res.status}\n${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : {};
}

const get = e => call('GET', e);

async function versions(versionString) {
  const r = await get(`/v1/apps/${APP_ID}/appStoreVersions?limit=50` +
    `&fields[appStoreVersions]=versionString,platform,appStoreState`);
  const all = r.data || [];
  return versionString ? all.filter(v => v.attributes.versionString === versionString) : all;
}

async function cmdStatus() {
  const editable = new Set(['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED']);
  const rows = (await versions()).filter(v => editable.has(v.attributes.appStoreState));
  if (!rows.length) return console.log('No editable version records.');
  for (const v of rows) {
    const { platform, versionString, appStoreState } = v.attributes;
    const build = await get(`/v1/appStoreVersions/${v.id}/build?fields[builds]=version`);
    const locs = await get(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations` +
      `?fields[appStoreVersionLocalizations]=locale,whatsNew`);
    console.log(`\n${platform}  ${versionString}  ${appStoreState}`);
    console.log(`  build:     ${build.data ? `build ${build.data.attributes.version}` : 'NONE ATTACHED'}`);
    for (const l of locs.data || []) {
      const w = l.attributes.whatsNew;
      const hash = w ? crypto.createHash('sha256').update(w).digest('hex').slice(0, 16) : '-';
      console.log(`  whatsNew:  ${l.attributes.locale} ${w ? `${w.length} chars sha256:${hash}` : 'EMPTY'}`);
    }
  }
}

async function cmdSetNotes(versionString, file) {
  if (!versionString || !file) die('usage: set-notes <version> <file>');
  const text = fs.readFileSync(file, 'utf8').replace(/\n+$/, '');
  if (text.length > 4000) die(`What's New is ${text.length} chars, over Apple's 4000 cap`);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  console.log(`${text.length} chars, sha256:${hash.slice(0, 16)}`);

  const rows = await versions(versionString);
  if (!rows.length) die(`No version records for ${versionString}`);
  for (const v of rows) {
    const locs = await get(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale`);
    for (const l of locs.data || []) {
      await call('PATCH', `/v1/appStoreVersionLocalizations/${l.id}`, {
        data: { type: 'appStoreVersionLocalizations', id: l.id, attributes: { whatsNew: text } },
      });
      console.log(`  set ${v.attributes.platform} ${l.attributes.locale}`);
    }
  }
  console.log('\nVerifying against Apple:');
  await verifyNotes(versionString, hash);
}

async function verifyNotes(versionString, expected) {
  let ok = true;
  for (const v of await versions(versionString)) {
    const locs = await get(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations` +
      `?fields[appStoreVersionLocalizations]=locale,whatsNew`);
    for (const l of locs.data || []) {
      const w = l.attributes.whatsNew || '';
      const h = crypto.createHash('sha256').update(w).digest('hex');
      const match = h === expected;
      if (!match) ok = false;
      console.log(`  ${v.attributes.platform.padEnd(7)} ${l.attributes.locale} ${match ? 'matches' : '*** MISMATCH ***'}`);
    }
  }
  if (!ok) process.exit(1);
}

// Builds arrive asynchronously; Apple needs a few minutes to process one
// before it can be attached to a version.
async function cmdAttach(versionString, buildNumber) {
  if (!versionString || !buildNumber) die('usage: attach <version> <buildNumber>');
  const r = await get(`/v1/builds?filter[app]=${APP_ID}&filter[version]=${buildNumber}` +
    `&limit=200&fields[builds]=version,processingState,uploadedDate`);
  const builds = (r.data || []).filter(b => b.attributes.processingState === 'VALID');
  if (!builds.length) die(`No VALID build ${buildNumber}. Still processing, or never uploaded.`);

  for (const v of await versions(versionString)) {
    // Each platform has its own build; match by the platform's own build list.
    const plat = v.attributes.platform;
    const candidates = [];
    for (const b of builds) {
      const pre = await get(`/v1/builds/${b.id}/preReleaseVersion?fields[preReleaseVersions]=platform`);
      if (pre.data?.attributes?.platform === plat) candidates.push(b);
    }
    if (!candidates.length) { console.log(`  ${plat}: no build ${buildNumber} for this platform, skipped`); continue; }
    const pick = candidates.sort((a, b) =>
      new Date(b.attributes.uploadedDate) - new Date(a.attributes.uploadedDate))[0];
    await call('PATCH', `/v1/appStoreVersions/${v.id}/relationships/build`, {
      data: { type: 'builds', id: pick.id },
    });
    console.log(`  ${plat}: attached build ${buildNumber} (${pick.attributes.uploadedDate})`);
  }
}

// altool's -t is not implied by the extension: a tvOS build is also a .ipa but
// must go up as `appletvos`, and sending it as `ios` is rejected. Read the
// platform out of the bundle instead of guessing.
function ipaPlatform(file) {
  const raw = spawnSync('sh', ['-c',
    `unzip -p ${JSON.stringify(file)} 'Payload/*.app/Info.plist' | ` +
    `plutil -extract CFBundleSupportedPlatforms json -o - -`], { encoding: 'utf8' });
  let declared = [];
  try { declared = JSON.parse(raw.stdout.trim()); } catch { /* fall through */ }
  const map = { AppleTVOS: 'appletvos', iPhoneOS: 'ios', XROS: 'visionos' };
  const type = map[declared[0]];
  if (!type) die(`Could not read a supported platform from ${file} (got ${JSON.stringify(declared)})`);
  return type;
}

function cmdUpload(file) {
  if (!file) die('usage: upload <path-to-.ipa-or-.pkg>');
  if (!fs.existsSync(file)) die(`No such file: ${file}`);
  const type = file.endsWith('.pkg') ? 'macos'
    : file.endsWith('.ipa') ? ipaPlatform(file)
    : die('expected .ipa or .pkg');
  console.log(`platform: ${type}`);
  const args = ['altool', '--upload-app', '-f', file, '-t', type,
    '--apiKey', KEY_ID, '--apiIssuer', issuerId()];
  console.log(`xcrun ${args.join(' ')}`);
  return new Promise(resolve => {
    const p = spawn('xcrun', args, { stdio: 'inherit' });
    p.on('exit', code => { if (code !== 0) process.exit(code); resolve(); });
  });
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'status': await cmdStatus(); break;
  case 'set-notes': await cmdSetNotes(rest[0], rest[1]); break;
  case 'attach': await cmdAttach(rest[0], rest[1]); break;
  case 'upload': await cmdUpload(rest[0]); break;
  default:
    console.log('usage: node scripts/asc.mjs <status | set-notes <version> <file> | attach <version> <build> | upload <file>>');
    process.exit(cmd ? 1 : 0);
}
