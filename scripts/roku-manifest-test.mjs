// Tests for the Roku channel manifest and its artwork.
//
//   node scripts/roku-manifest-test.mjs
//
// Roku's certification rejects a channel whose manifest is missing a required
// attribute or whose artwork is the wrong size, and the failure arrives days
// later as a rejection rather than immediately as a broken build. Nothing else
// in this repo can catch it: `bsc` validates BrightScript and component wiring,
// not the manifest, and the channel runs perfectly well on a sideloaded device
// with art that would never pass review.
//
// That is exactly how the channel sat for months with `mm_icon_focus_hd` at
// 336x210 (the required size is 290x218 — a different aspect ratio entirely),
// no `mm_icon_focus_fhd` at all, and no `splash_screen_sd`, all three of which
// are required attributes.
//
// Deliberately dependency-free: the repo has no image library, so the PNG and
// JPEG headers are parsed here. Both formats put the dimensions in a fixed
// place near the front, which is all this needs.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rokuDir = join(repoRoot, 'roku');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- manifest ----
const manifest = {};
for (const line of readFileSync(join(rokuDir, 'manifest'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i > 0) manifest[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}

// ---- image dimensions, without a dependency ----
function pngSize(buf) {
  // 8-byte signature, then the IHDR chunk: length(4) type(4) width(4) height(4)
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  while (o < buf.length) {
    if (buf[o] !== 0xff) { o++; continue; }
    const marker = buf[o + 1];
    // SOF0..SOF15, excluding the non-frame markers DHT/JPG/DAC
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7) };
    }
    o += 2 + buf.readUInt16BE(o + 2);
  }
  return null;
}

function sizeOf(pkgPath) {
  const rel = pkgPath.replace(/^pkg:\//, '');
  const file = join(rokuDir, rel);
  if (!existsSync(file)) return null;
  const buf = readFileSync(file);
  return rel.toLowerCase().endsWith('.png') ? pngSize(buf) : jpegSize(buf);
}

console.log('\nRoku manifest and channel artwork\n');

// ---- 1. required attributes ----
for (const key of ['title', 'major_version', 'minor_version', 'build_version',
                   'mm_icon_focus_fhd', 'mm_icon_focus_hd',
                   'splash_screen_fhd', 'splash_screen_hd', 'splash_screen_sd']) {
  check(`manifest declares ${key}`, !!manifest[key], '(required by certification)');
}

// ---- 2. artwork is exactly the size Roku expects ----
const SIZES = {
  mm_icon_focus_fhd: [540, 405],
  mm_icon_focus_hd: [290, 218],
  splash_screen_fhd: [1920, 1080],
  splash_screen_hd: [1280, 720],
  splash_screen_sd: [720, 480],
};
for (const [key, [w, h]] of Object.entries(SIZES)) {
  const got = manifest[key] ? sizeOf(manifest[key]) : null;
  check(`${key} is ${w}x${h}`, got && got.w === w && got.h === h,
    got ? `got ${got.w}x${got.h}` : '(file missing or unreadable)');
}

// ---- 3. every referenced file exists ----
for (const [key, value] of Object.entries(manifest)) {
  if (!value.startsWith('pkg:/')) continue;
  check(`${key} points at a file that exists`,
    existsSync(join(rokuDir, value.replace(/^pkg:\//, ''))), value);
}

// ---- 4. deprecated attributes are gone ----
// Shipping these is not fatal, but they are dead weight and the sd/side icons
// were the ones carrying wrong dimensions.
for (const key of ['mm_icon_focus_sd', 'mm_icon_side_hd', 'mm_icon_side_sd']) {
  check(`deprecated ${key} is not declared`, !manifest[key]);
}

// ---- 5. the build-time legacy override never ships enabled ----
// `sideload.mjs --legacy` patches this in the staged copy only. A commit with
// it set true would put every device on the low-fidelity path.
const bsConst = manifest.bs_const || '';
check('bs_const does not ship FORCE_LEGACY=true', !/FORCE_LEGACY\s*=\s*true/.test(bsConst), bsConst);
check('bs_const does not ship DEBUG=true', !/(^|;)\s*DEBUG\s*=\s*true/.test(bsConst), bsConst);

// ---- 6. no cross-app launching, which certification prohibits ----
// A channel may not deep link into another app. The ECP trick is reaching the
// device's own :8060 from inside the channel, so that is what to look for.
import { readdirSync, statSync } from 'node:fs';
function walk(dir) {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    if (e === 'node_modules' || e.startsWith('.')) return [];
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sources = walk(rokuDir).filter((f) => /\.(brs|xml)$/.test(f));
const offenders = sources.filter((f) => /:8060|\/launch\/\d/.test(readFileSync(f, 'utf8')));
check('no source launches another channel over ECP', offenders.length === 0,
  offenders.map((f) => f.replace(repoRoot + '/', '')).join(', '));

// ---- 7. deep linking is either implemented or not claimed ----
// Certification requires a channel declaring supports_input_launch to honour
// contentId/mediaType. Claiming it without a handler is a rejection.
const mainScene = readFileSync(join(rokuDir, 'components/MainScene.brs'), 'utf8');
const claimsDeepLink = manifest.supports_input_launch === '1';
const handlesDeepLink = /launchArgs/.test(mainScene) && /contentId/i.test(mainScene);
check('supports_input_launch is only declared when it is handled',
  !claimsDeepLink || handlesDeepLink,
  claimsDeepLink ? 'declared but MainScene never reads contentId' : '');

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
