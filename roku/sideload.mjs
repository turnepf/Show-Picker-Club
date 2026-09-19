#!/usr/bin/env node
// Roku operator tool — validate, package and sideload the channel.
//
// Roku ships no simulator, so a real device is the only way to run this
// channel. That made the edit loop a manual chore: zip the folder, open the
// device's web UI in a browser, pick the file, click Replace. This does the
// whole thing in one command, and refuses to install anything that does not
// pass `bsc` first — a channel that fails validation will crash on the device,
// and finding that out over telnet is slower than not sending it.
//
// Credentials are deliberately NOT in this repo, matching scripts/asc.mjs:
// the device address comes from $ROKU_HOST or ~/.roku/host, and the developer
// web-server password from $ROKU_PASSWORD or ~/.roku/password.
//
//   node roku/sideload.mjs info        device model, OS, UI resolution
//   node roku/sideload.mjs logs        stream the debug console (port 8085)
//   node roku/sideload.mjs shot [name] screenshot the current screen
//   node roku/sideload.mjs keys Down Select Back   drive the remote over ECP
//   node roku/sideload.mjs type 5551234567           type into the focused field
//   node roku/sideload.mjs logs --relaunch --seconds 15
//   node roku/sideload.mjs             validate, package, install
//   node roku/sideload.mjs --legacy    install a build forced to the legacy tier
//   node roku/sideload.mjs --skip-check   install without validating
//
// `logs --relaunch` is the quickest way to confirm which tier DeviceProfile()
// picked: it attaches to the console first, then restarts the channel, so the
// launch line is captured rather than missed. Attaching afterwards shows only
// what the channel prints next, which for a startup line is nothing.
//
// The console is a plain TCP stream, handled here with node:net rather than
// `telnet <ip> 8085 | timeout`, because macOS ships neither `timeout` nor
// `telnet` and the loop should not depend on installing either.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { rokuDeploy } from 'roku-deploy';

const ROKU_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.join(os.homedir(), '.roku');

// Only the channel itself goes to the device. The tooling that builds it
// (node_modules, package.json, bsconfig.json) and the docs must stay out of
// the zip — node_modules alone is larger than the entire channel.
const CHANNEL_FILES = [
  'manifest',
  'source/**/*',
  'components/**/*',
  'images/**/*',
  '!**/*.md', // images/README.md documents the artwork; the device has no use for it
];

function die(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

// $VAR wins over the file, so a second device is one env var away.
function credential(envVar, fileName, label, hint) {
  if (process.env[envVar]) return process.env[envVar].trim();
  const file = path.join(CONFIG_DIR, fileName);
  try {
    const v = fs.readFileSync(file, 'utf8').trim();
    if (v) return v;
  } catch { /* fall through to the error below */ }
  die(`No ${label}.\n\nSet it once:\n    mkdir -p ${CONFIG_DIR}\n    printf '%s' '${hint}' > ${file}\n\nOr pass it for a single run with ${envVar}=...`);
}

const host = () => credential('ROKU_HOST', 'host', 'Roku address', '192.168.1.50');

// `info` reads the device over ECP (port 8060), which is unauthenticated — so
// it must not demand the developer password. Only an install needs that.
function deployOptions() {
  return {
    host: host(),
    password: credential('ROKU_PASSWORD', 'password', 'developer web-server password', 'your-dev-password'),
    rootDir: ROKU_DIR,
    files: CHANNEL_FILES,
    outDir: path.join(ROKU_DIR, '.out'),
    outFile: 'showpicker-roku.zip',
  };
}

// A channel that fails validation crashes on the device, and the failure
// arrives as a runtime error over telnet rather than as the compile error it
// actually is. Catch it here instead.
function validate() {
  console.log('Validating (bsc)…');
  const r = spawnSync('npx', ['bsc', '--project', 'bsconfig.json'], {
    cwd: ROKU_DIR, stdio: 'inherit',
  });
  if (r.status !== 0) die('Validation failed — not sideloading. Fix the errors above, or pass --skip-check to install anyway.');
}

// ECP reports what the device IS, not how it draws: there is no
// graphics-platform field in /query/device-info. Only the channel can answer
// that, via roDeviceInfo.GetGraphicsPlatform() at launch — so this prints the
// facts ECP has and points at the log line for the tier, rather than guessing
// a tier from a field that is always absent.
async function info() {
  const d = await rokuDeploy.getDeviceInfo({ host: host(), remotePort: 8060 });
  console.log(`
  Model      ${d['model-number']}  ${d['friendly-model-name'] ?? d['model-name'] ?? ''}
  Form       ${d['is-tv'] === true || d['is-tv'] === 'true' ? 'Roku TV' : d['is-stick'] === true || d['is-stick'] === 'true' ? 'streaming stick' : 'set-top box'}
  OS         ${d['software-version']}.${d['software-build']}
  UI output  ${d['ui-resolution'] ?? '?'}

  Tier is decided on the device, not here — ECP does not report the graphics
  platform. Sideload and read the launch line:

      telnet ${host()} 8085     ->  [showpicker] device tier=... graphics=...

  To exercise the legacy path on a modern device: node sideload.mjs --legacy
`);
}

// Flip a bs_const in the STAGED manifest. The committed manifest is never
// touched, so an interrupted run cannot leave the repo holding a debug build.
function forceLegacyInStaging(stagingDir) {
  const manifest = path.join(stagingDir, 'manifest');
  const before = fs.readFileSync(manifest, 'utf8');
  const after = before.replace(/FORCE_LEGACY=false/, 'FORCE_LEGACY=true');
  if (after === before) die('Could not find FORCE_LEGACY=false in the staged manifest.');
  fs.writeFileSync(manifest, after);
}

// ECP: restart the sideloaded channel. 204 is success and carries no body.
async function relaunchDevChannel() {
  const res = await fetch(`http://${host()}:8060/launch/dev`, { method: 'POST' });
  if (!res.ok) die(`Could not relaunch the channel (HTTP ${res.status}). Is it installed?`);
}

function flagValue(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

async function logs(args) {
  const seconds = flagValue(args, '--seconds', 0);
  const address = host();

  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: address, port: 8085 }, async () => {
      console.log(`--- ${address}:8085 ${seconds ? `(${seconds}s)` : '(ctrl-c to stop)'} ---`);
      // Attached: now it is safe to restart, and the launch prints will land
      // on this stream instead of being missed.
      if (args.includes('--relaunch')) {
        await relaunchDevChannel().catch(reject);
      }
    });
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => process.stdout.write(chunk));
    socket.on('error', (e) => reject(new Error(`Debug console: ${e.message}`)));
    socket.on('close', resolve);
    if (seconds) setTimeout(() => socket.destroy(), seconds * 1000).unref?.();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ECP key names are case-sensitive and a wrong one returns 200 while doing
// nothing, so they are checked here rather than silently swallowed.
const ECP_KEYS = new Set(['Home', 'Rev', 'Fwd', 'Play', 'Select', 'Left', 'Right',
  'Down', 'Up', 'Back', 'InstantReplay', 'Info', 'Backspace', 'Search', 'Enter']);

// Driving the remote needs "Control by mobile apps -> Network access" set to
// Permissive on the device; Roku OS 14+ returns 403 by default. Launching the
// channel and reading device info are not affected by that setting.
async function keys(args) {
  const wanted = args.slice(args.indexOf('keys') + 1).filter((a) => !a.startsWith('--'));
  if (!wanted.length) die('Usage: sideload.mjs keys <Key> [Key...]  e.g. keys Down Select Back');
  const bad = wanted.filter((k) => !ECP_KEYS.has(k));
  if (bad.length) die(`Not ECP key names: ${bad.join(', ')}\nValid: ${[...ECP_KEYS].join(', ')}`);

  for (const k of wanted) {
    const res = await fetch(`http://${host()}:8060/keypress/${k}`, { method: 'POST' });
    if (res.status === 403) {
      die('403 from the device. Set Settings -> System -> Advanced system settings -> Control by mobile apps -> Network access to Permissive.');
    }
    if (!res.ok) die(`${k}: HTTP ${res.status}`);
    console.log(`  ${k}`);
    await sleep(900); // let the UI settle and any request finish
  }
}

// ECP types a literal character with /keypress/Lit_<urlencoded char>, which
// goes straight into the focused text field. Far faster and less error-prone
// than walking the on-screen keyboard grid with arrow keys.
async function typeText(args) {
  const text = args[args.indexOf('type') + 1];
  if (!text) die('Usage: sideload.mjs type <text>');
  for (const ch of text) {
    const res = await fetch(`http://${host()}:8060/keypress/Lit_${encodeURIComponent(ch)}`, { method: 'POST' });
    if (res.status === 403) die('403 — set Control by mobile apps -> Network access to Permissive.');
    if (!res.ok) die(`typing "${ch}": HTTP ${res.status}`);
    await sleep(120);
  }
  console.log(`  typed ${text.length} character(s)`);
}

async function shot(args) {
  const name = args[args.indexOf('shot') + 1] || 'screen';
  const outDir = path.join(ROKU_DIR, '.out', 'shots');
  const file = await rokuDeploy.takeScreenshot({
    host: host(),
    password: credential('ROKU_PASSWORD', 'password', 'developer web-server password', 'your-dev-password'),
    outDir,
    outFile: name,
  });
  console.log(file);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('keys')) {
    await keys(args);
    return;
  }

  if (args.includes('type')) {
    await typeText(args);
    return;
  }

  if (args.includes('shot')) {
    await shot(args);
    return;
  }

  if (args.includes('info')) {
    await info();
    return;
  }

  if (args.includes('logs')) {
    await logs(args);
    return;
  }

  const opts = deployOptions();
  const legacy = args.includes('--legacy');
  if (!args.includes('--skip-check')) validate();

  if (legacy) {
    // Staged build: copy, patch the constant, zip, upload. Same steps
    // rokuDeploy.deploy() runs, with one edit in the middle.
    const stagingDir = path.join(opts.outDir, 'staging');
    const staged = { ...opts, stagingDir };
    console.log('Building with FORCE_LEGACY=true …');
    await rokuDeploy.prepublishToStaging(staged);
    forceLegacyInStaging(stagingDir);
    await rokuDeploy.zipPackage(staged);
    console.log(`Installing to ${opts.host} …`);
    await rokuDeploy.publish(staged);
    console.log('Installed a FORCED LEGACY build — re-run without --legacy to go back.');
  } else {
    console.log(`Packaging and installing to ${opts.host} …`);
    await rokuDeploy.deploy(opts);
    console.log('Installed.');
  }

  console.log(`Logs: telnet ${opts.host} 8085`);
}

main().catch(err => die(err?.message ?? String(err)));
