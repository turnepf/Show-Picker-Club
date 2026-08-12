// Tests for the vibe matcher — functions/_shared/vibe-match.js.
//
//   node scripts/vibe-match-test.mjs
//
// Written for the 2026-08 "most members come back Prestige Drama Loyalist"
// report. The cause wasn't the cluster definitions, it was the comparison: a
// fingerprint is an average over dozens of titles, so every member's sits close
// to the average of all television, and self-centring left that shared shape in
// place. Cosine similarity then largely measured "does this look like TV", and
// the cluster nearest the average show won for nearly everyone.
//
// The matcher now scores a member against the club's own distribution. The
// properties that has to hold — none of which a histogram can prove, because a
// histogram only shows what today's data happens to do:
//
//   1. A trait the whole club shares carries no information and must not
//      decide anyone's cluster, however strongly a cluster target names it.
//   2. Members who differ in taste land in different clusters — the same two
//      libraries that used to collapse onto one label.
//   3. A cluster says nothing about most traits, and silence is not a vote:
//      unspecified dimensions must not move the score.
//   4. An average member gets an honest answer (~50%, no daylight), not a
//      confident-looking label.
//   5. A club too small to have a distribution falls back rather than
//      dividing by a spread it made up from two people.
//
// Pure functions, no database, no network.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'vibe-match-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');
const load = (p) => import(join(sandbox, 'functions', p));

const { TRAIT_NAMES } = await load('_shared/vibe-traits.js');
const { CLUSTERS } = await load('_shared/vibe-clusters.js');
const { MIN_SCORED_FOR_CLUSTER, clubBaseline, computeFingerprint, pickCluster } =
  await load('_shared/vibe-match.js');

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// A fingerprint at the middle of every trait, with named traits overridden.
const fp = (overrides = {}) => {
  const v = {};
  for (const t of TRAIT_NAMES) v[t] = 0.5;
  return Object.assign(v, overrides);
};

console.log('\n== a trait the whole club shares does not decide anyone');
{
  // Everyone is equally dark and morally ambiguous — the shape all prestige TV
  // has in common. The only thing separating these members is warmth.
  const club = [
    fp({ darkness: 0.9, moral_ambiguity: 0.9, prestige_energy: 0.9, warmth: 0.30 }),
    fp({ darkness: 0.9, moral_ambiguity: 0.9, prestige_energy: 0.9, warmth: 0.45 }),
    fp({ darkness: 0.9, moral_ambiguity: 0.9, prestige_energy: 0.9, warmth: 0.60 }),
    fp({ darkness: 0.9, moral_ambiguity: 0.9, prestige_energy: 0.9, warmth: 0.75 }),
  ];
  const baseline = clubBaseline(club);
  check('the baseline is built from all four', baseline && baseline.members === 4,
        JSON.stringify(baseline && baseline.members));
  check('a trait nobody differs on collapses to the spread floor',
        baseline.spread.darkness <= 0.02 + 1e-9, String(baseline.spread.darkness));

  const warm = pickCluster(club[3], baseline);
  const cold = pickCluster(club[0], baseline);
  check('the warmest member is not filed under the shared darkness',
        warm.id !== 'dark_complexity' && warm.id !== 'prestige_drama', warm.name);
  check('and the two ends of the one axis that varies split apart',
        warm.id !== cold.id, `${warm.name} vs ${cold.name}`);
}

console.log('\n== members with different taste get different clusters');
{
  const club = [
    fp({ warmth: 0.85, comfort_coziness: 0.85, community_belonging: 0.8, optimism: 0.8 }),
    fp({ power_orientation: 0.85, status_obsession: 0.8, manipulation: 0.75, cynicism: 0.7 }),
    fp({ chaos_intensity: 0.85, absurdism: 0.85, emotional_volatility: 0.8 }),
    fp({ satire: 0.85, cynicism: 0.8, cruel_humor: 0.7 }),
    fp({ empathy: 0.85, healing_redemption: 0.85, emotional_repair: 0.8 }),
  ];
  const baseline = clubBaseline(club);
  const picks = club.map((f) => pickCluster(f, baseline).id);
  check('five distinct libraries produce five distinct clusters',
        new Set(picks).size === 5, JSON.stringify(picks));
  check('the cosy one reads cosy', picks[0] === 'warm_comfort', picks[0]);
  check('the scheming one reads power', picks[1] === 'power_game', picks[1]);
  check('every match is reported on a 0–1 scale the clients can render',
        club.every((f) => {
          const s = pickCluster(f, baseline).similarity;
          return s >= 0 && s <= 1;
        }));
}

console.log('\n== the reported symptom, reproduced');
{
  // What a hundred-title average actually looks like: a strong shared "this is
  // television" shape — most of what anyone watches is somewhat prestigious,
  // morally complicated and reasonably smart — with each member's personal
  // tilt only a few points on top of it. This is the shape that collapsed
  // every member onto one label, and it collapses harder the more titles
  // someone has, which is the opposite of what a taste read should do.
  const shared = {
    prestige_energy: 0.66, moral_ambiguity: 0.64, intellectual_curiosity: 0.62,
    darkness: 0.55, emotional_volatility: 0.58, growth_orientation: 0.57,
    empathy: 0.56, warmth: 0.52, comfort_coziness: 0.45, absurdism: 0.40,
    cruel_humor: 0.35, nihilism: 0.33, satire: 0.42,
  };
  const TILT = 0.03;
  const tilts = {
    cosy: ['warmth', 'comfort_coziness', 'community_belonging', 'optimism'],
    power: ['power_orientation', 'status_obsession', 'manipulation'],
    chaos: ['chaos_intensity', 'absurdism'],
    satire: ['satire', 'cynicism', 'cruel_humor'],
    healer: ['empathy', 'healing_redemption', 'emotional_repair'],
    dark: ['darkness', 'violence_intensity'],
  };
  const club = Object.values(tilts).map((traits) => {
    const f = fp(shared);
    for (const t of traits) f[t] = (f[t] ?? 0.5) + TILT;
    return f;
  });
  const baseline = clubBaseline(club);
  const picks = club.map((f) => pickCluster(f, baseline).id);
  check(`six libraries separated by ${TILT} land in six clusters, not one`,
        new Set(picks).size === 6, JSON.stringify(picks));
  check('and none of them is decided by the prestige shape they all share',
        picks.filter((p) => p === 'prestige_drama').length <= 1, JSON.stringify(picks));
}

console.log('\n== a cluster only votes on the traits it names');
{
  const club = [fp({ satire: 0.3 }), fp({ satire: 0.5 }), fp({ satire: 0.7 }), fp({ satire: 0.9 })];
  const baseline = clubBaseline(club);
  const before = pickCluster(club[3], baseline);

  // Move a trait no cluster target mentions. Nothing about anyone's cluster
  // should shift — under the old 0.5-filled targets it did.
  const untouched = TRAIT_NAMES.find((t) =>
    ['violence_intensity', 'teamwork', 'runtime'].includes(t)) || 'teamwork';
  const shifted = club.map((f) => ({ ...f, [untouched]: 0.9 }));
  const after = pickCluster(shifted[3], clubBaseline(shifted));
  check(`moving "${untouched}" (named by no cluster) leaves the verdict alone`,
        before.id === after.id, `${before.name} → ${after.name}`);
}

console.log('\n== an average member gets an honest answer');
{
  const club = [fp({ warmth: 0.4 }), fp({ warmth: 0.5 }), fp({ warmth: 0.6 }), fp({ warmth: 0.5 })];
  const baseline = clubBaseline(club);
  const middle = pickCluster(fp({ warmth: 0.5 }), baseline);
  check('a member sitting on the club mean scores ~50%, not a confident label',
        Math.abs(middle.similarity - 0.5) < 0.02, String(middle.similarity));
  check('and reports no daylight behind the winner',
        Math.abs(middle.margin) < 0.02, String(middle.margin));
}

console.log('\n== too small a club falls back instead of inventing a spread');
{
  check('two fingerprints are not a distribution', clubBaseline([fp(), fp()]) === null);
  check('nor is one', clubBaseline([fp()]) === null);
  check('nor is none', clubBaseline([]) === null);

  const solo = pickCluster(fp({ warmth: 0.9, comfort_coziness: 0.9, optimism: 0.85 }), null);
  check('a member still gets a cluster with no baseline at all',
        solo.id === 'warm_comfort', solo.name);
  check('and the response says the baseline was empty',
        solo.baseline_members === 0, String(solo.baseline_members));
}

console.log('\n== a library too thin to read gets no persona at all');
{
  const club = [fp({ warmth: 0.4 }), fp({ warmth: 0.55 }), fp({ warmth: 0.7 }), fp({ warmth: 0.5 })];
  const baseline = clubBaseline(club);
  const strong = fp({ warmth: 0.9, comfort_coziness: 0.9 });

  check('one scored title names nobody',
        pickCluster(strong, baseline, { scoredTitles: 1 }) === null);
  check('four is still too few',
        pickCluster(strong, baseline, { scoredTitles: 4 }) === null);
  check(`${MIN_SCORED_FOR_CLUSTER} is the line`,
        pickCluster(strong, baseline, { scoredTitles: MIN_SCORED_FOR_CLUSTER }) !== null);
  check('and a caller that says nothing about size still gets an answer',
        pickCluster(strong, baseline) !== null);
}

console.log('\n== a photo finish says so instead of picking a side');
{
  // Two clusters pulling on the same member: warmth up, cosiness up, but
  // equally strong empathy and repair. Whichever wins, it wins narrowly.
  const club = [
    fp({ warmth: 0.45, empathy: 0.45 }),
    fp({ warmth: 0.55, empathy: 0.55 }),
    fp({ warmth: 0.50, empathy: 0.50 }),
    fp({ warmth: 0.60, empathy: 0.60 }),
  ];
  const baseline = clubBaseline(club);
  // Walk from one archetype to the other; somewhere in between the two
  // clusters cross, and that member is the one the copy has to be honest to.
  const cosy = { warmth: 0.85, comfort_coziness: 0.85, community_belonging: 0.8, optimism: 0.8 };
  const healing = { empathy: 0.85, healing_redemption: 0.85, emotional_repair: 0.85, growth_orientation: 0.8 };
  let closest = null;
  for (let i = 0; i <= 40; i++) {
    const k = i / 40;
    const blendFp = fp();
    for (const [t, v] of Object.entries(cosy)) blendFp[t] = 0.5 + (v - 0.5) * (1 - k);
    for (const [t, v] of Object.entries(healing)) blendFp[t] = 0.5 + (v - 0.5) * k;
    const got = pickCluster(blendFp, baseline);
    if (!closest || got.margin < closest.margin) closest = got;
  }
  check('somewhere between two archetypes a member is genuinely undecided',
        closest.undecided, `closest margin ${closest.margin.toFixed(3)}`);
  check('and the tagline names both clusters rather than asserting one',
        closest.tagline.includes(closest.name) && closest.tagline.includes(closest.blend[1].name),
        closest.tagline);

  const decisive = pickCluster(fp({ satire: 0.95, cynicism: 0.9, cruel_humor: 0.85 }), baseline);
  check('a decisive match keeps the cluster\'s own tagline',
        !decisive.undecided && decisive.tagline === CLUSTERS.find((c) => c.id === decisive.id).tagline,
        `${decisive.margin.toFixed(3)} — ${decisive.tagline}`);
}

console.log('\n== list weights still shape the fingerprint');
{
  // Loved counts 1.0 and Next Up 0.3, so a wishlist can colour a read without
  // overruling what someone actually watches.
  const loved = { list: 'recommending', ...fp({ warmth: 1 }) };
  const nextUp = { list: 'next', ...fp({ warmth: 0 }) };
  const both = computeFingerprint([loved, nextUp]);
  check('a Loved row outweighs a Next Up row',
        both.warmth > 0.7, String(both.warmth));
  check('rows on no weighted list contribute nothing',
        computeFingerprint([{ list: 'nonsense', ...fp({ warmth: 1 }) }]) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
