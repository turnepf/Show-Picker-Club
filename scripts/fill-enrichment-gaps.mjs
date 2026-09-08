// Drive /api/enrich's `gaps` mode until the library holds no empty rows.
//
//   CRON_SECRET=… node scripts/fill-enrichment-gaps.mjs
//   CRON_SECRET=… node scripts/fill-enrichment-gaps.mjs --dry-run
//   CRON_SECRET=… node scripts/fill-enrichment-gaps.mjs --max-rounds 40 --sleep 5
//
// Why this exists rather than another rotation pass.
//
// The rate-limit bug in /api/enrich's tmdbGet (fixed 2026-08-11) read TMDB's
// 429 body as "no such title" and then did the correct thing for a hopeless
// title: stamped enriched_at on every copy and moved on. So the damaged rows
// are not un-enriched — they are marked DONE, with no cast and no episode
// count, carrying a fresh timestamp. The ordinary queue is oldest-first, so
// those rows sit at the BACK: a plain re-run retries the entire library before
// reaching them, and the sweep that would fix them is the one least likely to.
//
// `mode: 'gaps'` selects on the absence of data instead of on age, which is
// the only ordering that finds them. This script just calls it until the
// endpoint reports nothing left, sleeping between rounds because the whole
// incident was caused by hammering TMDB.
//
// Read-only until it isn't: --dry-run reports the outstanding count and exits
// without enriching anything.

const BASE = process.env.BASE_URL || 'https://showpicker.club';
const SECRET = process.env.CRON_SECRET;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : dflt;
};
// Rounds are bounded so a bug in the endpoint can't spin forever. 60 rounds at
// the default batch covers a library far larger than this one.
const maxRounds = num('--max-rounds', 60);
const sleepSecs = num('--sleep', 4);
const maxTmdb = num('--max-tmdb', 20);
// `--mode logos` drives the one-time movie service-badge sweep instead of the
// cast/episode gaps backlog. It needs a different stop rule: a film that only
// rents has no flatrate provider and therefore no logo to fetch, so the count
// bottoms out above zero instead of reaching it. Stop when it stops falling.
const modeArg = (() => {
  const i = args.indexOf('--mode');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'gaps';
})();
if (!['gaps', 'logos'].includes(modeArg)) {
  console.error(`Unknown --mode ${modeArg}. Expected 'gaps' or 'logos'.`);
  process.exit(1);
}

if (!SECRET) {
  console.error('CRON_SECRET is not set. It is the same secret the scheduled');
  console.error('enrichment workflows send as X-Cron-Secret.');
  process.exit(1);
}

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function round(probeOnly) {
  const res = await fetch(`${BASE}/api/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': SECRET },
    // max_tmdb 0 makes the passes select nothing, so the response is just the
    // remaining count — a probe that spends no TMDB budget.
    body: JSON.stringify({ mode: modeArg, max_tmdb: probeOnly ? 0 : maxTmdb }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const first = await round(true);
const start = first.remaining;
if (!start) {
  console.error(`No \`remaining\` in the response — is this deploy running ${modeArg} mode yet?`);
  process.exit(1);
}
console.log(modeArg === 'logos'
  ? `Outstanding: ${start.movies} films with no service badge`
  : `Outstanding: ${start.total} titles (${start.tv} series, ${start.movies} films)`);

if (dryRun) {
  console.log('--dry-run — nothing enriched.');
  process.exit(0);
}
if (start.total === 0) {
  console.log('Nothing to fill.');
  process.exit(0);
}

let filled = 0, stalls = 0, prevLeft = start.total;
for (let i = 1; i <= maxRounds; i++) {
  const r = await round(false);
  const left = r.remaining?.total ?? null;
  const did = (r.tvCandidates || 0) + (r.movieCandidates || 0);
  filled += r.tmdbUpdated || 0;
  console.log(
    `round ${String(i).padStart(2)}  attempted ${String(did).padStart(3)}  ` +
    `updated ${String(r.tmdbUpdated || 0).padStart(3)}  remaining ${left}` +
    (r.budgetExhausted ? '  (budget exhausted)' : '') +
    (r.tvErrors || r.movieErrors ? `  errors ${r.tvErrors + r.movieErrors}: ${r.lastError || ''}` : '')
  );

  if (left === 0) { console.log(`\nDone — ${filled} titles updated.`); process.exit(0); }

  // A round that attempted work and changed nothing means what's left can't be
  // fixed by retrying: titles TMDB genuinely has no match for. Stop rather
  // than burn the API forever — three in a row, so one bad round doesn't end
  // an otherwise-working run.
  // In logos mode the count is the only honest progress signal: `tmdbUpdated`
  // counts a row whose poster came back, which is every row here, so it stays
  // positive even when no badge was actually filled.
  const madeProgress = modeArg === 'logos'
    ? (left !== null && left < prevLeft)
    : (r.tmdbUpdated > 0);
  prevLeft = left ?? prevLeft;

  if (did > 0 && !madeProgress) {
    if (++stalls >= 3) {
      if (modeArg === 'logos') {
        console.log(`\nStopped: ${left} films left with no badge to fetch — these stream`);
        console.log('nowhere on a subscription, so TMDB lists no flatrate provider and');
        console.log('there is no logo to take. Expected, not damage.');
      } else {
        console.log(`\nStopped: ${left} titles left that TMDB can't match. These are`);
        console.log('genuine no-matches, not the rate-limit damage — inspect them by hand.');
      }
      process.exit(0);
    }
  } else {
    stalls = 0;
  }
  await sleep(sleepSecs);
}
console.log(`\nHit --max-rounds (${maxRounds}). Re-run to continue.`);
