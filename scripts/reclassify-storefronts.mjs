// Walk the Apple TV+ backlog until nothing is left to re-check.
//
//   CRON_SECRET=… node scripts/reclassify-storefronts.mjs
//   CRON_SECRET=… node scripts/reclassify-storefronts.mjs --dry-run
//   CRON_SECRET=… node scripts/reclassify-storefronts.mjs --network "Apple TV+"
//
// Why this exists. tv.apple.com serves Apple TV+ originals and $3.99 rentals
// from the same URL shape, so before #337 every pasted Apple link landed on
// "Apple TV+" — telling the Subscription Audit that a member needed to keep
// paying Apple every month for what was actually a one-off rental.
//
// #337 fixed the classification at insert time, so NEW rows are right. It
// repaired nothing already stored, and no other pass will: /api/enrich's
// rotation never touches storefront classification. Without this, the legacy
// backlog sits there forever.
//
// The endpoint re-derives each title's network from TMDB's rent/buy arrays and
// moves the genuinely-rented ones off the subscription. Links are left alone —
// a tv.apple.com URL on a rental is correct, it's the *carrier* that was wrong.
//
// Idempotent. `remaining` counts titles not checked in the last hour, so a run
// drives it to zero and a later run finds only what has since rotated.

const BASE = process.env.BASE_URL || 'https://showpicker.club';
const SECRET = process.env.CRON_SECRET;
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const val = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const network = val('--network', 'Apple TV+');
const maxRounds = Number(val('--max-rounds', '40'));
const maxTitles = Number(val('--max-titles', '40'));
const sleepSecs = Number(val('--sleep', '3'));

if (!SECRET) {
  console.error('CRON_SECRET is not set. It is the same secret the scheduled');
  console.error('workflows send as X-Cron-Secret, and the only action it can');
  console.error('reach on this endpoint is the reclassification below.');
  process.exit(1);
}

const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function round(titles) {
  const res = await fetch(`${BASE}/api/admin-url-cleanup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Cron-Secret': SECRET },
    body: JSON.stringify({ action: 'reclassify_storefronts', network, max_titles: titles }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error);
  return j;
}

// max_titles 0 makes the pass select nothing, so this is a probe that spends
// no TMDB budget and just reports the size of the backlog.
const probe = await round(0);
console.log(`Outstanding on "${network}": ${probe.remaining} titles`);

if (dryRun) {
  console.log('--dry-run — nothing reclassified.');
  process.exit(0);
}
if (!probe.remaining) {
  console.log('Nothing to re-check.');
  process.exit(0);
}

let movedRows = 0, checkedTotal = 0;
for (let i = 1; i <= maxRounds; i++) {
  const r = await round(maxTitles);
  checkedTotal += r.checked || 0;
  movedRows += r.rows_changed || 0;
  console.log(
    `round ${String(i).padStart(2)}  checked ${String(r.checked || 0).padStart(3)}  ` +
    `moved ${String(r.rows_changed || 0).padStart(3)} rows  ` +
    `kept ${r.kept ?? 0}  unknown ${r.unknown ?? 0}  remaining ${r.remaining}`
  );
  if (!r.remaining) break;
  // A round that checked nothing has nothing left it can reach this hour —
  // `remaining` counts titles not stamped in the last hour, so continuing
  // would spin without progress.
  if (!r.checked) {
    console.log('\nNo more titles eligible this pass.');
    break;
  }
  await sleep(sleepSecs);
}

console.log(`\nDone — checked ${checkedTotal} titles, moved ${movedRows} rows off "${network}".`);
