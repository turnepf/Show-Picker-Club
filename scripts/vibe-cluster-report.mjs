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
// --why explains each verdict: which traits carried it, and how far from the
// club the member sits on them. A label nobody can account for is a label
// nobody should trust.
const explain = argv.includes('--why');
// Below this many scored titles a fingerprint is a rumour, not a taste.
const THIN_LIBRARY = 5;

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const h1 = (s) => console.log(`\n${bold(`== ${s}`)}`);

const load = functionsSandbox();
const { TRAIT_NAMES } = await load('_shared/vibe-traits.js');
const { CLUSTERS } = await load('_shared/vibe-clusters.js');
const { EXCLUDED_FROM_TASTE } = await load('_shared/excluded-members.js');
const { assignDistinct, clubBaseline, computeFingerprint, cosineSim, centerFp, pickCluster } =
  await load('_shared/vibe-match.js');

// Per-trait share of the winning cosine: how much each trait actually carried
// the verdict, and in which direction the cluster wanted it.
function drivers(fp, baseline, cluster) {
  const z = {}, dir = {};
  for (const t of TRAIT_NAMES) {
    z[t] = baseline
      ? Math.max(-3, Math.min(3, ((fp[t] || 0) - baseline.mean[t]) / baseline.spread[t]))
      : (fp[t] || 0) - 0.5;
    dir[t] = (cluster.target[t] ?? 0.5) - 0.5;
  }
  const nz = Math.sqrt(TRAIT_NAMES.reduce((a, t) => a + z[t] * z[t], 0));
  const nd = Math.sqrt(TRAIT_NAMES.reduce((a, t) => a + dir[t] * dir[t], 0));
  return TRAIT_NAMES
    .map((t) => ({ trait: t, z: z[t], wants: dir[t], share: (z[t] * dir[t]) / (nz * nd || 1) }))
    .filter((x) => x.wants !== 0)
    .sort((a, b) => b.share - a.share);
}

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
// A fingerprint is keyed by show (migration 081) — showKeySql('s') in
// functions/_shared/same-show.js, spelled out here for the snapshot db.
const KEY = `CASE WHEN s.tmdb_id IS NOT NULL THEN COALESCE(s.tmdb_type, CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END) || ':' || s.tmdb_id
  ELSE 'title:' || LOWER(TRIM(s.title)) END`;

const rows = db.prepare(
  `SELECT s.member_slug, s.list, ${traitCols}
     FROM shows s
     JOIN title_traits t ON t.show_key = ${KEY}
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

// The endpoint hands out distinct personas within a member's largest group
// (ties to the oldest), so the report has to do the same or it reports a
// distribution nobody sees.
const memberships = db.prepare('SELECT group_id, member_slug FROM group_members').all();
const groupSize = new Map();
for (const m of memberships) groupSize.set(m.group_id, (groupSize.get(m.group_id) || 0) + 1);
const primaryGroup = new Map();
for (const m of memberships) {
  const held = primaryGroup.get(m.member_slug);
  if (!held
      || groupSize.get(m.group_id) > groupSize.get(held)
      || (groupSize.get(m.group_id) === groupSize.get(held) && m.group_id < held)) {
    primaryGroup.set(m.member_slug, m.group_id);
  }
}
const groupRoster = new Map();
for (const [slug, gid] of primaryGroup) {
  if (!groupRoster.has(gid)) groupRoster.set(gid, []);
  groupRoster.get(gid).push(slug);
}
const assigned = new Map();
for (const [, slugs] of groupRoster) {
  const entries = slugs
    .filter((slug) => fingerprints.has(slug))
    .map((slug) => ({
      slug, fp: fingerprints.get(slug), scoredTitles: byMember.get(slug).length,
    }));
  for (const [slug, id] of assignDistinct(entries, baseline)) assigned.set(slug, id);
}

const named = new Map(
  db.prepare('SELECT slug, first_name, name FROM members').all()
    .map((m) => [m.slug, m.first_name || m.name])
);

const results = [...fingerprints.entries()].map(([slug, fp]) => ({
  slug,
  name: named.get(slug) || slug,
  titles: byMember.get(slug).length,
  fp,
  old: pickClusterOld(fp),
  neu: pickCluster(fp, baseline, { preferId: assigned.get(slug) || null }),
  group: primaryGroup.get(slug) ?? null,
})).sort((a, b) => b.titles - a.titles);

h1('Per member');
console.log(dim('  member                titles  before                     after                       match  margin  runner-up'));
const clusterById = new Map(CLUSTERS.map((c) => [c.id, c]));
for (const r of results) {
  const changed = r.old.name !== r.neu.name;
  const arrow = changed ? '→' : '=';
  const thin = r.titles < THIN_LIBRARY ? dim('  ← too few titles to mean anything') : '';
  const runnerUp = r.neu.blend[1] ? r.neu.blend[1].name : '';
  console.log(`  ${r.name.slice(0, 20).padEnd(20)} ${String(r.titles).padStart(6)}  ` +
    `${r.old.name.padEnd(26)} ${arrow} ${(changed ? bold(r.neu.name) : dim(r.neu.name)).padEnd(34)} ` +
    `${String(Math.round(r.neu.similarity * 100)).padStart(4)}%  ${r.neu.margin.toFixed(3)}  ` +
    `${dim(runnerUp)}${thin}`);
  if (!explain) continue;
  const top = drivers(r.fp, baseline, clusterById.get(r.neu.id)).slice(0, 3);
  for (const d of top) {
    const side = d.wants > 0 ? 'high' : 'low';
    const sign = d.z >= 0 ? '+' : '−';
    console.log(dim(`        ${d.trait.padEnd(22)} member ${sign}${Math.abs(d.z).toFixed(1)}σ` +
      `   cluster wants ${side.padEnd(4)}   carries ${(d.share * 100).toFixed(0)}%`));
  }
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

h1('Inside each group');
console.log(dim('  A repeated persona inside one group is the thing to look for.'));
const groupName = new Map(db.prepare('SELECT id, name FROM groups').all().map((g) => [g.id, g.name]));
for (const [gid, slugs] of [...groupRoster].sort((a, b) => b[1].length - a[1].length)) {
  const members = results.filter((r) => r.group === gid);
  if (!members.length) continue;
  const ids = members.map((m) => m.neu.id);
  const dupes = ids.length - new Set(ids).size;
  console.log(`\n  ${bold(groupName.get(gid) || `group ${gid}`)} ` +
    dim(`${members.length} scored member${members.length === 1 ? '' : 's'}` +
      (dupes ? ` — ${dupes} repeat${dupes === 1 ? '' : 's'}` : ' — all different')));
  for (const m of members) {
    console.log(`    ${m.name.slice(0, 18).padEnd(18)} ${m.neu.name.padEnd(26)} ` +
      `${m.neu.assigned ? dim(`(moved off ${m.neu.blend[1].name}, taken)`) : ''}`);
  }
}

h1('Distribution');
histogram('before', (r) => r.old.name);
histogram('after', (r) => r.neu.name);

const undecided = results.filter((r) => r.neu.margin < 0.05).length;
const thin = results.filter((r) => r.titles < THIN_LIBRARY).length;
h1('Read');
console.log(`  ${results.filter((r) => r.old.name !== r.neu.name).length} of ${results.length}` +
  ' members change cluster.');
console.log(`  ${undecided} sit within 0.05 of a second cluster — genuinely between two vibes,` +
  ' which the blend already shows.');
console.log(`  ${thin} have fewer than ${THIN_LIBRARY} scored titles, where any label is noise —` +
  ' the endpoint now returns no cluster for them at all.');
console.log(`  ${undecided} get the between-two-vibes tagline instead of a flat assertion.`);
console.log(`  ${results.filter((r) => r.neu.assigned).length} were moved off their own top match` +
  ' so a group-mate could keep it.');
if (!explain) console.log(dim('\n  Re-run with --why to see which traits carried each verdict.'));
console.log('');
