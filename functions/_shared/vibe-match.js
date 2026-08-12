import { TRAIT_NAMES } from './vibe-traits.js';
import { CLUSTERS } from './vibe-clusters.js';

// The matching half of the vibe system: member fingerprint in, cluster out.
// Split out of functions/api/vibe.js so the endpoint and the offline cluster
// report (scripts/vibe-cluster-report.mjs) score members through the same code
// rather than two implementations that drift.

// Per-list weights for the fingerprint. Loved = strongest endorsement;
// Next Up = weakest (curiosity, not commitment). Archived rows are ignored.
export const LIST_WEIGHT = { recommending: 1.0, watching: 0.8, waiting: 0.6, next: 0.3 };

// A trait where members barely differ carries no information about who someone
// is, and dividing by its tiny spread would turn rounding noise into a signal.
const MIN_SPREAD = 0.02;
// No single trait may swing a match more than this many standard deviations.
const Z_CAP = 3;
// Below this many fingerprints the club spread isn't a distribution, it's an
// anecdote. Fall back to the flat baseline rather than trusting it.
const MIN_BASELINE_MEMBERS = 3;
// Below this many scored titles a fingerprint is a rumour. A member with one
// show sits three standard deviations from the club on whatever that show
// happens to be, and the matcher will hand them a confident persona built
// entirely out of it. Better to say nothing: the clients render the traits,
// balance and picks without a cluster box.
export const MIN_SCORED_FOR_CLUSTER = 5;
// Cosine daylight over the runner-up, below which naming one cluster and
// walking away overstates what the numbers know.
const UNDECIDED_MARGIN = 0.05;

export function computeFingerprint(rows) {
  const sums = {};
  for (const t of TRAIT_NAMES) sums[t] = 0;
  let totalWeight = 0;
  for (const r of rows) {
    const w = LIST_WEIGHT[r.list] || 0;
    if (w === 0) continue;
    for (const t of TRAIT_NAMES) {
      if (typeof r[t] === 'number') sums[t] += w * r[t];
    }
    totalWeight += w;
  }
  if (totalWeight === 0) return null;
  const fp = {};
  for (const t of TRAIT_NAMES) fp[t] = sums[t] / totalWeight;
  return fp;
}

export function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (const t of TRAIT_NAMES) {
    const av = a[t] || 0, bv = b[t] || 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

// Center a fingerprint by subtracting its own mean. Used for outlier picks,
// where the question is "how does this title deviate from the member's own
// average" — a within-member comparison that wants no club context.
export function centerFp(fp) {
  const values = TRAIT_NAMES.map(t => fp[t] || 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const out = {};
  for (const t of TRAIT_NAMES) out[t] = (fp[t] || 0) - mean;
  return out;
}

// Mean and spread per trait across the club's member fingerprints.
//
// This is the fix for "everyone is a Prestige Drama Loyalist". A fingerprint is
// an average over dozens of titles, so it sits very close to the average of all
// television: every member scores highish on prestige_energy and
// moral_ambiguity because most of what anyone watches does. Subtracting a
// vector's OWN mean (what this used to do) leaves that shared shape standing,
// so cosine similarity mostly measured "does this look like TV", and the
// cluster nearest the average show won for nearly everybody.
//
// Against the club baseline the question becomes the one the feature is asking:
// where does this member sit relative to their peers? Dividing by each trait's
// spread finishes the job — a trait everyone shares stops counting, and the few
// where this member is genuinely unusual decide their cluster.
export function clubBaseline(fingerprints) {
  const usable = (fingerprints || []).filter(Boolean);
  if (usable.length < MIN_BASELINE_MEMBERS) return null;
  const mean = {}, spread = {};
  for (const t of TRAIT_NAMES) {
    const xs = usable.map(fp => fp[t] || 0);
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    mean[t] = m;
    spread[t] = Math.max(Math.sqrt(v), MIN_SPREAD);
  }
  return { mean, spread, members: usable.length };
}

// Where this member sits relative to the club, in standard deviations.
function zScore(fp, baseline) {
  const out = {};
  for (const t of TRAIT_NAMES) {
    if (!baseline) {
      // No usable club distribution (a new or tiny club): fall back to the
      // flat baseline — deviation from the midpoint of each trait's range.
      out[t] = (fp[t] || 0) - 0.5;
      continue;
    }
    const z = ((fp[t] || 0) - baseline.mean[t]) / baseline.spread[t];
    out[t] = Math.max(-Z_CAP, Math.min(Z_CAP, z));
  }
  return out;
}

// A cluster target states an opinion on a handful of traits and says nothing
// about the rest. `vibe-clusters.js` fills the unspecified ones with 0.5, which
// is the midpoint — so subtracting 0.5 turns the target into a direction, and
// the traits the cluster has no opinion about drop out of the dot product
// instead of quietly voting.
function clusterDirection(cluster) {
  const dir = {};
  for (const t of TRAIT_NAMES) dir[t] = (cluster.target[t] ?? 0.5) - 0.5;
  return dir;
}

// Cosine lives in [-1, 1]; the clients render this as a percentage, so map it
// onto [0, 1] where 0.5 means "no relationship either way".
const asMatch = (cos) => (cos + 1) / 2;

// `scoredTitles` is how many of the member's shows actually carried traits.
// Pass it and a library too thin to read returns null rather than a persona.
// Every cluster scored for this member, best first.
export function rankClusters(fp, baseline) {
  const z = zScore(fp, baseline);
  return CLUSTERS
    .map(c => ({ cluster: c, cos: cosineSim(z, clusterDirection(c)) }))
    .sort((a, b) => b.cos - a.cos);
}

// Hand out distinct clusters across a group.
//
// This is a deliberate trade of accuracy for fun. A vibe is a party trick, and
// the trick stops working when you and the three people you watch television
// with are all handed the same persona — the whole point is comparing. So
// within a group nobody shares a label while there are labels left: take the
// strongest member/cluster pair going, give it out, cross both off, repeat.
//
// Greedy rather than optimal (Hungarian) on purpose: with eight clusters and
// club-sized groups the difference is a rounding error, and greedy is short
// enough to read. Ties break on slug then cluster id so the same group always
// produces the same assignment — a persona that shuffles between requests is
// worse than one that's merely second-best.
//
// A group larger than the cluster list runs out; whoever is left takes their
// own best match and repeats are allowed again. Members too thin to be scored
// at all don't take a slot.
export function assignDistinct(entries, baseline) {
  const ranked = new Map();
  for (const e of entries || []) {
    if (!e.fp) continue;
    if (e.scoredTitles != null && e.scoredTitles < MIN_SCORED_FOR_CLUSTER) continue;
    ranked.set(e.slug, rankClusters(e.fp, baseline));
  }

  const pairs = [];
  for (const [slug, rows] of ranked) {
    for (const r of rows) pairs.push({ slug, id: r.cluster.id, cos: r.cos });
  }
  pairs.sort((a, b) => b.cos - a.cos || a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id));

  const out = new Map();
  const taken = new Set();
  for (const p of pairs) {
    if (out.has(p.slug) || taken.has(p.id)) continue;
    out.set(p.slug, p.id);
    taken.add(p.id);
  }
  for (const [slug, rows] of ranked) if (!out.has(slug)) out.set(slug, rows[0].cluster.id);
  return out;
}

// `preferId` is the cluster this member was assigned by their group. It leads
// the response; the blend behind it stays in true order, so the honest ranking
// is always one glance away.
export function pickCluster(fp, baseline, { scoredTitles = null, preferId = null } = {}) {
  if (scoredTitles !== null && scoredTitles < MIN_SCORED_FOR_CLUSTER) return null;

  const trueRanked = rankClusters(fp, baseline);
  const ranked = preferId
    ? [
        ...trueRanked.filter(r => r.cluster.id === preferId),
        ...trueRanked.filter(r => r.cluster.id !== preferId),
      ]
    : trueRanked;

  const best = ranked[0];
  // Daylight is always measured against the member's own second-best, not
  // against whatever the group assignment pushed down the list.
  const margin = trueRanked[0].cos - (trueRanked[1]?.cos ?? trueRanked[0].cos);
  const assigned = !!preferId && preferId !== trueRanked[0].cluster.id;
  // A photo finish is a fact about the member, not a rounding error to hide.
  // The tagline is the one line of copy the clients render under the cluster
  // name, so it's where the hedge belongs — no app change required.
  // Two reasons the stock tagline would overstate things: the member is
  // sitting on a fence, or the group handed them their runner-up so nobody
  // doubled up. Say which, rather than reading like a verdict either way.
  let tagline = best.cluster.tagline;
  if (assigned) {
    tagline = `${best.cluster.tagline} (Closest unclaimed vibe in your group — ` +
      `${trueRanked[0].cluster.name} was taken.)`;
  } else if (margin < UNDECIDED_MARGIN && trueRanked[1]) {
    tagline = `You sit between ${best.cluster.name} and ${trueRanked[1].cluster.name}` +
      ' — the blend below is the truer read.';
  }

  return {
    id: best.cluster.id,
    name: best.cluster.name,
    tagline,
    similarity: asMatch(best.cos),
    // How much daylight there is behind the winner.
    margin,
    undecided: margin < UNDECIDED_MARGIN,
    // True when the group's variety rule moved this member off their own top
    // match so a group-mate could keep it.
    assigned,
    baseline_members: baseline ? baseline.members : 0,
    blend: ranked.slice(0, 3).map(r => ({
      id: r.cluster.id,
      name: r.cluster.name,
      similarity: asMatch(r.cos),
    })),
  };
}
