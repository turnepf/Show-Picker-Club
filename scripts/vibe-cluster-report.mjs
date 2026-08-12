#!/usr/bin/env node
//
// Cluster assignment across the whole club, old algorithm versus new.
//
//   node scripts/vibe-cluster-report.mjs
//   node scripts/vibe-cluster-report.mjs --snapshot /tmp/club.json
//   node scripts/vibe-cluster-report.mjs --from /tmp/club.json
//
// Written for the 2026-08 "most members come back Prestige Drama Loyalist"
// report. A member fingerprint is an average over dozens of titles, so it sits
// very close to the average of all television: everyone scores highish on
// prestige_energy and moral_ambiguity because most of what anyone watches does.
// The old matcher subtracted each vector's OWN mean, which leaves that shared
// shape standing — so cosine similarity largely measured "does this look like
// TV", and the cluster nearest the average show won for nearly everybody.
//
// The new matcher (functions/_shared/vibe-match.js) scores each member against
// the club's own distribution: how far from the average member, in units of how
// much members actually vary on that trait. Traits everyone shares stop voting.
//
// This prints both, side by side, on real data — because "more variety" is a
// claim about a distribution and has to be measured, not asserted. It changes
// nothing; it only reports.

import {
  envFor, functionsSandbox, hydrate, loadSnapshot, saveSnapshot, takeSnapshot,
} from './lib/prod-snapshot.mjs';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};
const snapshotOut = flagValue('--snapshot');
const snapshotIn = flagValue('--from');

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const h1 = (s) => console.log(`\n${bold(`== ${s}`)}`);

const load = functionsSandbox();
const { TRAIT_NAMES } = await load('_shared/vibe-traits.js');
const { CLUSTERS } = await load('_shared/vibe-clusters.js');
const { EXCLUDED_FROM_TASTE } = await load('_shared/excluded-members.js');
const { clubBaseline, computeFingerprint, cosineSim, centerFp, pickCluster } =
  await load('_shared/vibe-match.js');

// The shipped-before-today matcher, kept here so the comparison is real rather
// than remembered: self-centre both sides, cosine, highest wins.
function pickClusterOld(fp) {
  const memberCentered = centerFp(fp);
  const ranked = CLUSTERS.map((c) => ({
    cluster: c,
    sim: cosineSim(memberCentered, centerFp(c.target)),
  })).sort((a, b) => b.sim - a.sim);
  return { name: ranked[0].cluster.name, margin: ranked[0].sim - ranked[1].sim };
}

if (!snapshotIn) h1('Snapshotting production D1 (read-only)');
const snapshot = snapshotIn
  ? loadSnapshot(snapshotIn)
  : takeSnapshot('club', (s) => process.stdout.write(dim(s)));
if (snapshotOut) {
  saveSnapshot(snapshot, snapshotOut);
  console.log(dim(`  wrote ${snapshotOut}`));
}

const db = hydrate(snapshot);
const env = envFor(db);
const traitCols = TRAIT_NAMES.map((t) => `t.${t}`).join(', ');

const rows = db.prepare(
  `SELECT s.member_slug, s.list, ${traitCols}
     FROM shows s
     JOIN show_traits t ON LOWER(s.title) = t.title_lower
      AND (t.unknown_show = 0 OR t.unknown_show IS NULL)
    WHERE s.archived = 0`
).all();

const byMember = new Map();
for (const r of rows) {
  if (!byMember.has(r.member_slug)) byMember.set(r.member_slug, []);
  byMember.get(r.member_slug).push(r);
}

const fingerprints = new Map();
for (const [slug, memberRows] of byMember) {
  const fp = computeFingerprint(memberRows);
  if (fp) fingerprints.set(slug, fp);
}

// The endpoint builds its baseline from unexcluded members only — a sprawling
// library shouldn't set the club's centre of gravity any more than it should
// rank Trending.
const baseline = clubBaseline(
  [...fingerprints.entries()]
    .filter(([slug]) => !EXCLUDED_FROM_TASTE.includes(slug))
    .map(([, fp]) => fp)
);

h1('Club baseline');
console.log(`  fingerprints: ${fingerprints.size} members ` +
  `(${baseline ? `${baseline.members} feed the baseline` : dim('too few — flat baseline in use')})`);
if (baseline) {
  const spread = TRAIT_NAMES.map((t) => ({ t, s: baseline.spread[t], m: baseline.mean[t] }))
    .sort((a, b) => b.s - a.s);
  console.log(dim('  traits members differ on most — these decide clusters now'));
  for (const x of spread.slice(0, 6)) {
    console.log(`    ${x.t.padEnd(24)} mean ${x.m.toFixed(3)}  spread ${x.s.toFixed(3)}`);
  }
  console.log(dim('  traits members barely differ on — these no longer vote'));
  for (const x of spread.slice(-4)) {
    console.log(`    ${x.t.padEnd(24)} mean ${x.m.toFixed(3)}  spread ${x.s.toFixed(3)}`);
  }
}

const named = new Map(
  db.prepare('SELECT slug, first_name, name FROM members').all()
    .map((m) => [m.slug, m.first_name || m.name])
);

const results = [...fingerprints.entries()].map(([slug, fp]) => ({
  slug,
  name: named.get(slug) || slug,
  titles: byMember.get(slug).length,
  old: pickClusterOld(fp),
  neu: pickCluster(fp, baseline),
})).sort((a, b) => b.titles - a.titles);

h1('Per member');
console.log(dim('  member                titles  before                     after                      margin'));
for (const r of results) {
  const changed = r.old.name !== r.neu.name;
  const arrow = changed ? '→' : '=';
  console.log(`  ${r.name.slice(0, 20).padEnd(20)} ${String(r.titles).padStart(6)}  ` +
    `${r.old.name.padEnd(26)} ${arrow} ${(changed ? bold(r.neu.name) : dim(r.neu.name)).padEnd(changed ? 34 : 34)} ` +
    `${r.neu.margin.toFixed(3)}`);
}

function histogram(label, pick) {
  const counts = new Map();
  for (const r of results) counts.set(pick(r), (counts.get(pick(r)) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  console.log(`\n  ${bold(label)} ${dim(`${ranked.length} of ${CLUSTERS.length} clusters used, ` +
    `biggest bucket ${Math.round((top[1] / results.length) * 100)}%`)}`);
  for (const [name, n] of ranked) {
    console.log(`    ${name.padEnd(28)} ${'█'.repeat(n).padEnd(Math.max(12, results.length))} ${n}`);
  }
}

h1('Distribution');
histogram('before', (r) => r.old.name);
histogram('after', (r) => r.neu.name);

const undecided = results.filter((r) => r.neu.margin < 0.05).length;
h1('Read');
console.log(`  ${results.filter((r) => r.old.name !== r.neu.name).length} of ${results.length}` +
  ' members change cluster.');
console.log(`  ${undecided} sit within 0.05 of a second cluster — genuinely between two vibes,` +
  ' which the blend already shows.');
console.log('');
