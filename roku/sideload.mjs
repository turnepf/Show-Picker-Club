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
//   node roku/sideload.mjs info        device model, OS, graphics platform
//   node roku/sideload.mjs             validate, package, install
//   node roku/sideload.mjs --skip-check   install without validating
//
// `info` is the quickest way to confirm which tier DeviceProfile() will pick:
// graphics "opengl" is the modern tier, anything else is legacy.

import fs from 'node:fs';
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
const CHANNEL_FILES = ['manifest', 'source/**/*', 'components/**/*', 'images/**/*'];

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

function options() {
  return {
    host: credential('ROKU_HOST', 'host', 'Roku address', '192.168.1.50'),
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

async function info(opts) {
  const d = await rokuDeploy.getDeviceInfo({ host: opts.host, remotePort: 8060 });
  const graphics = d['graphics-platform'] ?? '(not reported)';
  console.log(`
  Model     ${d['model-number']}  ${d['friendly-model-name'] ?? d['user-device-name'] ?? ''}
  OS        ${d['software-version']}.${d['software-build']}
  Display   ${d['ui-resolution'] ?? '?'}  (${d['display-type'] ?? '?'})
  Graphics  ${graphics}
  Tier      ${String(graphics).toLowerCase() === 'opengl' ? 'modern' : 'legacy'}  <- what DeviceProfile() will pick
`);
}

async function main() {
  const args = process.argv.slice(2);
  const opts = options();

  if (args.includes('info')) {
    await info(opts);
    return;
  }

  if (!args.includes('--skip-check')) validate();

  console.log(`Packaging and installing to ${opts.host} …`);
  await rokuDeploy.deploy(opts);
  console.log('Installed. Channel should be running on the TV now.');
  console.log(`Logs: telnet ${opts.host} 8085`);
}

main().catch(err => die(err?.message ?? String(err)));
