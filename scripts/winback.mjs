// Operator driver for the "we saved your spot" email (POST /api/admin-winback,
// functions/_shared/winback.js). Run from the Actions tab → "Win-back email",
// or locally with the secret:
//
//   CRON_SECRET=… node scripts/winback.mjs --mode plan
//   CRON_SECRET=… node scripts/winback.mjs --mode preview
//   CRON_SECRET=… node scripts/winback.mjs --mode send --confirm send
//
// plan prints counts only unless --details is passed. The repository is
// public and so are its Actions logs, so the workflow never passes it: who's
// inactive is not something to publish. send stops at the first failure.

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const mode = opt('mode', 'plan');
const confirm = opt('confirm', '');
const base = opt('base', 'https://showpicker.club');
const details = args.includes('--details');
const secret = process.env.CRON_SECRET;
if (!secret) { console.error('CRON_SECRET is not set'); process.exit(1); }

async function call(body) {
  const res = await fetch(`${base}/api/admin-winback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': secret },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { console.error(`HTTP ${res.status}:`, data.error || data); process.exit(1); }
  return data;
}

if (mode === 'plan') {
  const p = await call({ mode: 'plan' });
  console.log(`Inactive members (60+ days): ${p.inactive}`);
  for (const [v, n] of Object.entries(p.by_version)) console.log(`  ${v.padEnd(9)} ${n}`);
  console.log(`No email address: ${p.no_email}`);
  console.log(`Already sent this lapse: ${p.already_sent}`);
  console.log(`A send would email: ${p.would_send}`);
  if (details) for (const m of p.members) {
    console.log(`  ${m.slug.padEnd(20)} ${m.version.padEnd(9)} last seen ${m.last_seen}${m.has_email ? '' : '  (no email)'}${m.already_sent ? '  (sent)' : ''}`);
  }
} else if (mode === 'preview') {
  const p = await call({ mode: 'preview' });
  for (const s of p.sent) console.log(`  ${s.version.padEnd(9)} ${s.ok ? 'sent' : `FAILED ${s.error}`}`);
  console.log(`Previews go to ${p.to} only.`);
} else if (mode === 'send') {
  if (confirm !== 'send') { console.error('send needs --confirm send'); process.exit(1); }
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const r = await call({ mode: 'send', confirm: 'send', limit: 10 });
    total += r.sent;
    console.log(`Round ${round + 1}: sent ${r.sent}, failed ${r.failed}, remaining ${r.remaining}`);
    if (r.failed > 0) {
      for (const x of r.results.filter((y) => !y.ok)) console.error(`  failed (${x.version}): ${x.error}`);
      process.exit(1);
    }
    if (r.remaining === 0 || r.sent === 0) break;
  }
  console.log(`Done. ${total} sent.`);
} else {
  console.error('--mode must be plan, preview or send');
  process.exit(1);
}
