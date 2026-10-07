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
//   node scripts/asc.mjs create-version 1.6
//   node scripts/asc.mjs submit 1.6 --confirm
//
// Sending a version to review is a person's decision. `submit` exists so that
// decision doesn't need a browser, but it only runs with --confirm, refuses a
// platform missing a build or What's New text, and is run by Patrick himself
// (Claude's App Store Connect writes are blocked; it hands him the line).

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

// Every version record, following Apple's pagination: at three records a
// release, a single page of 50 stops containing the newest version after
// about sixteen releases.
// One crawl per run: several commands ask twice (set-notes then its verify,
// create-version then appPlatforms), and the history doesn't change under a
// read.
let versionCache = null;
async function versions(versionString) {
  if (!versionCache) versionCache = await fetchVersions();
  return versionString ? versionCache.filter(v => v.attributes.versionString === versionString) : versionCache;
}

async function fetchVersions() {
  const all = [];
  let next = `/v1/apps/${APP_ID}/appStoreVersions?limit=200` +
    `&fields[appStoreVersions]=versionString,platform,appStoreState`;
  while (next) {
    const r = await get(next);
    all.push(...(r.data || []));
    next = r.links?.next ? r.links.next.replace(API, '') : null;
  }
  return all;
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

// --platform IOS|MAC_OS|TV_OS writes one platform only, for a release whose
// platforms ship different features (Apple TV has no Vibe screen, for one).
async function cmdSetNotes(versionString, file, platform) {
  if (!versionString || !file) die('usage: set-notes <version> <file> [--platform IOS|MAC_OS|TV_OS]');
  const text = fs.readFileSync(file, 'utf8').replace(/\n+$/, '');
  if (text.length > 4000) die(`What's New is ${text.length} chars, over Apple's 4000 cap`);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  console.log(`${text.length} chars, sha256:${hash.slice(0, 16)}`);

  const rows = (await versions(versionString)).filter(v => !platform || v.attributes.platform === platform);
  if (!rows.length) die(`No version records for ${versionString}${platform ? ` on ${platform}` : ''}`);
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
  await verifyNotes(versionString, hash, platform);
}

async function verifyNotes(versionString, expected, platform) {
  let ok = true;
  for (const v of (await versions(versionString)).filter(v => !platform || v.attributes.platform === platform)) {
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
  // Name the ONE top-level app rather than globbing for it. unzip's `*`
  // crosses `/`, so `Payload/*.app/Info.plist` also matched the embedded
  // watch app — `unzip -p` then concatenated two plists and `plutil` parsed
  // neither, so every iOS upload died on "Could not read a supported
  // platform ... (got [])". A .ipa holding no nested .app never hit it, which
  // is why this survived: the GUI's Organizer did the uploading until now.
  const listing = spawnSync('unzip', ['-Z1', file], { encoding: 'utf8' }).stdout || '';
  const entry = listing.split('\n')
    .map(l => l.trim())
    .find(l => /^Payload\/[^/]+\.app\/Info\.plist$/.test(l));
  if (!entry) die(`No top-level app Info.plist in ${file}`);
  const raw = spawnSync('sh', ['-c',
    `unzip -p ${JSON.stringify(file)} ${JSON.stringify(entry)} | ` +
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

// The platforms the app ships on, read from its own version history rather
// than hardcoded, so a platform added later is picked up.
async function appPlatforms() {
  return [...new Set((await versions()).map(v => v.attributes.platform))];
}

// One record per platform for a new version. Creating one fails with "You
// cannot create a new version of the App in the current state" while another
// release is in flight; with nothing in flight it works, and that's the
// normal case for a release that ships all platforms together.
// --platform IOS,TV_OS limits the create to those platforms: Apple refuses the
// API create on a platform whose previous version is still in review, and the
// others needn't wait for it.
async function cmdCreateVersion(versionString, only) {
  if (!versionString) die('usage: create-version <version> [--platform IOS,TV_OS]');
  const have = new Set((await versions(versionString)).map(v => v.attributes.platform));
  for (const platform of await appPlatforms()) {
    if (only && !only.includes(platform)) { console.log(`  ${platform}: skipped`); continue; }
    if (have.has(platform)) { console.log(`  ${platform}: ${versionString} already exists`); continue; }
    await call('POST', '/v1/appStoreVersions', {
      data: {
        type: 'appStoreVersions',
        attributes: { platform, versionString },
        relationships: { app: { data: { type: 'apps', id: APP_ID } } },
      },
    });
    console.log(`  ${platform}: created ${versionString}`);
  }
}

// Send every platform's record for a version to App Review. Checks first and
// changes nothing unless every platform passes: a build attached and What's
// New filled in. Without --confirm it only reports what it would submit.
//
// Safe to run again after a partial failure. A platform already waiting for
// or in review is skipped, not refused, and an open review submission left
// behind (by an earlier run that died between steps, or by "Add for Review"
// in the web UI) is reused rather than colliding with a new one.
const IN_REVIEW = new Set(['WAITING_FOR_REVIEW', 'IN_REVIEW']);

async function openSubmission(platform) {
  const r = await get(`/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[platform]=${platform}` +
    `&filter[state]=READY_FOR_REVIEW&limit=1`);
  return r.data?.[0]?.id || null;
}

async function submissionHasVersion(subId, versionId) {
  const r = await get(`/v1/reviewSubmissions/${subId}/items?include=appStoreVersion&limit=50`);
  return (r.data || []).some(i => i.relationships?.appStoreVersion?.data?.id === versionId);
}

async function cmdSubmit(versionString, flag) {
  if (!versionString) die('usage: submit <version> --confirm');
  const rows = await versions(versionString);
  if (!rows.length) die(`No version records for ${versionString}`);
  let ready = true;
  const toSend = [];
  for (const v of rows) {
    const plat = v.attributes.platform;
    const state = v.attributes.appStoreState;
    if (IN_REVIEW.has(state)) { console.log(`  ${plat.padEnd(7)} already ${state}, skipped`); continue; }
    const build = await get(`/v1/appStoreVersions/${v.id}/build?fields[builds]=version`);
    const locs = await get(`/v1/appStoreVersions/${v.id}/appStoreVersionLocalizations?fields[appStoreVersionLocalizations]=locale,whatsNew`);
    const missingNotes = (locs.data || []).filter(l => !(l.attributes.whatsNew || '').trim()).map(l => l.attributes.locale);
    const problems = [];
    if (state !== 'PREPARE_FOR_SUBMISSION') problems.push(`state is ${state}`);
    if (!build.data) problems.push('no build attached');
    if (missingNotes.length) problems.push(`no What's New for ${missingNotes.join(', ')}`);
    if (problems.length) ready = false; else toSend.push(v);
    console.log(`  ${plat.padEnd(7)} ${build.data ? `build ${build.data.attributes.version}` : '-'}  ${problems.length ? '*** ' + problems.join('; ') : 'ready'}`);
  }
  if (!ready) die('Not submitted. Fix the platforms above and run it again.');
  if (!toSend.length) return console.log(`\nNothing to send: every platform of ${versionString} is already in review.`);
  if (flag !== '--confirm') return console.log(`\nAll ready. Run again with --confirm to send ${versionString} to App Review.`);

  for (const v of toSend) {
    const plat = v.attributes.platform;
    let subId = await openSubmission(plat);
    // A submission created just now is empty, so only a reused one needs
    // checking for the version before adding it.
    const reused = !!subId;
    if (!subId) {
      const sub = await call('POST', '/v1/reviewSubmissions', {
        data: {
          type: 'reviewSubmissions',
          attributes: { platform: plat },
          relationships: { app: { data: { type: 'apps', id: APP_ID } } },
        },
      });
      subId = sub.data.id;
    }
    if (!reused || !(await submissionHasVersion(subId, v.id))) {
      await call('POST', '/v1/reviewSubmissionItems', {
        data: {
          type: 'reviewSubmissionItems',
          relationships: {
            reviewSubmission: { data: { type: 'reviewSubmissions', id: subId } },
            appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } },
          },
        },
      });
    }
    await call('PATCH', `/v1/reviewSubmissions/${subId}`, {
      data: { type: 'reviewSubmissions', id: subId, attributes: { submitted: true } },
    });
    console.log(`  ${plat}: submitted for review`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'status': await cmdStatus(); break;
  case 'set-notes': {
    // A bare or misspelled --platform must not fall through to "every
    // platform": that would put Apple TV's text on iPhone and Mac.
    const i = rest.indexOf('--platform');
    const platform = i === -1 ? null : rest[i + 1];
    if (i !== -1 && !['IOS', 'MAC_OS', 'TV_OS'].includes(platform)) {
      die(`--platform needs IOS, MAC_OS or TV_OS (got ${platform === undefined ? 'nothing' : platform})`);
    }
    await cmdSetNotes(rest[0], rest[1], platform);
    break;
  }
  case 'attach': await cmdAttach(rest[0], rest[1]); break;
  case 'upload': await cmdUpload(rest[0]); break;
  case 'create-version': {
    const i = rest.indexOf('--platform');
    const only = i === -1 ? null : (rest[i + 1] || '').split(',');
    if (only && !only.every(p => ['IOS', 'MAC_OS', 'TV_OS'].includes(p))) {
      die(`--platform needs IOS, MAC_OS or TV_OS, comma-separated (got ${rest[i + 1] || 'nothing'})`);
    }
    await cmdCreateVersion(rest[0], only);
    break;
  }
  case 'submit': await cmdSubmit(rest[0], rest[1]); break;
  default:
    console.log('usage: node scripts/asc.mjs <status | create-version <version> | set-notes <version> <file> | attach <version> <build> | upload <file> | submit <version> [--confirm]>');
    process.exit(cmd ? 1 : 0);
}
