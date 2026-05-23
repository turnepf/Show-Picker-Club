import { TRAIT_NAMES } from '../_shared/vibe-traits.js';
import { CLUSTERS } from '../_shared/vibe-clusters.js';
import { EXCLUDED_FROM_TASTE } from '../_shared/excluded-members.js';
import { getSession } from '../_shared/auth.js';

const EXCLUDED_SQL = EXCLUDED_FROM_TASTE.map(s => `'${s}'`).join(',');

// Per-list weights for the fingerprint. Recommending = strongest endorsement;
// Up Next = weakest (curiosity, not commitment). Archived rows are ignored.
const LIST_WEIGHT = { recommending: 1.0, watching: 0.8, waiting: 0.6, next: 0.3 };

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
}

function disambiguatedNames(rows) {
  const counts = {};
  for (const m of rows) {
    const fn = m.first_name || (m.name ? m.name.split(' ')[0] : m.slug);
    counts[fn] = (counts[fn] || 0) + 1;
  }
  return rows.map(m => {
    const fn = m.first_name || (m.name ? m.name.split(' ')[0] : m.slug);
    const display = counts[fn] > 1 && m.last_initial ? `${fn} ${m.last_initial}` : fn;
    return { ...m, display };
  });
}

async function listEligibleMembers(env) {
  const { results } = await env.DB.prepare(
    `SELECT m.slug, m.name, m.first_name, m.last_initial,
       (SELECT COUNT(*) FROM shows s WHERE s.member_slug = m.slug AND s.archived = 0) AS active_count
     FROM members m
     WHERE m.slug NOT IN (${EXCLUDED_SQL})
       AND EXISTS (
         SELECT 1 FROM shows s
         WHERE s.member_slug = m.slug
           AND (COALESCE(s.added_by, '') != 'seed' OR s.archived = 1 OR s.updated_at IS NOT NULL)
       )
     ORDER BY m.first_name COLLATE NOCASE`
  ).all();
  const named = disambiguatedNames(results);
  return named.map(m => ({ slug: m.slug, name: m.display, active_count: m.active_count }));
}

function computeFingerprint(rows) {
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

function cosineSim(a, b) {
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

// Center a fingerprint by subtracting its own mean. With centered vectors,
// cosine similarity becomes Pearson correlation — it measures how each
// trait *deviates* from the member's average, not absolute direction.
// This is the right thing for cluster matching: most members' lists have
// similar absolute shapes, so we need to compare patterns of deviation.
function centerFp(fp) {
  const values = TRAIT_NAMES.map(t => fp[t] || 0);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const out = {};
  for (const t of TRAIT_NAMES) out[t] = (fp[t] || 0) - mean;
  return out;
}

function pickCluster(fp) {
  const memberCentered = centerFp(fp);
  const ranked = CLUSTERS.map(c => ({
    cluster: c,
    sim: cosineSim(memberCentered, centerFp(c.target)),
  })).sort((a, b) => b.sim - a.sim);
  const best = ranked[0];
  return {
    id: best.cluster.id,
    name: best.cluster.name,
    tagline: best.cluster.tagline,
    similarity: best.sim,
    blend: ranked.slice(0, 3).map(r => ({
      id: r.cluster.id,
      name: r.cluster.name,
      similarity: r.sim,
    })),
  };
}

function avg(...xs) { return xs.reduce((a, b) => a + b, 0) / xs.length; }

function displayTraits(fp) {
  return {
    Warmth: Math.round(avg(fp.warmth, fp.comfort_coziness, fp.emotional_repair) * 100),
    Empathy: Math.round(fp.empathy * 100),
    Complexity: Math.round(avg(fp.moral_ambiguity, fp.emotional_volatility, fp.prestige_energy) * 100),
    'Cynicism risk': Math.round(avg(fp.cynicism, fp.nihilism, fp.cruel_humor) * 100),
    'Power orientation': Math.round(avg(fp.power_orientation, fp.status_obsession, fp.manipulation) * 100),
    Curiosity: Math.round(fp.intellectual_curiosity * 100),
    'Healing & growth': Math.round(avg(fp.healing_redemption, fp.growth_orientation) * 100),
    'Chaos tolerance': Math.round(fp.chaos_intensity * 100),
    'Humor (warm vs cruel)': Math.round((fp.humor_warmth - fp.cruel_humor + 1) / 2 * 100),
    Optimism: Math.round(fp.optimism * 100),
  };
}

function balanceMetrics(fp) {
  const values = TRAIT_NAMES.map(t => fp[t]);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  const stddev = Math.sqrt(variance);
  // Empirically the trait stddev for engaged members lands around 0.15–0.25.
  // Scaling by 400 maps that to a 60–100 range, capped.
  const range = Math.min(100, Math.round(stddev * 400));

  const warmthAvg = avg(fp.warmth, fp.comfort_coziness, fp.community_belonging, fp.emotional_repair);
  const darkAvg = avg(fp.darkness, fp.cynicism, fp.nihilism, fp.cruel_humor);
  const max = Math.max(warmthAvg, darkAvg, 0.01);
  const balance_score = Math.round((1 - Math.abs(warmthAvg - darkAvg) / max) * 100);
  let label;
  if (warmthAvg > darkAvg + 0.15) label = 'Warmth-leaning';
  else if (darkAvg > warmthAvg + 0.15) label = 'Tilted dark';
  else label = 'Balanced';

  return { range, warmth_darkness_balance: balance_score, warmth_darkness_label: label };
}

function alignedPicks(memberFp, candidatesScored, memberTitleSet) {
  const ranked = [];
  for (const c of candidatesScored) {
    if (memberTitleSet.has(c.title_lower)) continue;
    const fpC = {};
    for (const t of TRAIT_NAMES) fpC[t] = c[t];
    ranked.push({ row: c, sim: cosineSim(memberFp, fpC) });
  }
  ranked.sort((a, b) => b.sim - a.sim);
  return ranked.slice(0, 3).map(({ row }) => ({
    title: row.title,
    title_lower: row.title_lower,
    network: row.network,
    network_url: row.network_url,
    rating: row.rating,
  }));
}

function outlierPicks(memberFp, scoredRows) {
  // Shows the member has whose trait vector points opposite to their fingerprint.
  // We use centered cosine sim so it reflects deviation from their average.
  const memberCentered = centerFp(memberFp);
  const ranked = [];
  for (const r of scoredRows) {
    if (!r.title_lower) continue;
    const fpR = {};
    for (const t of TRAIT_NAMES) fpR[t] = r[t];
    const sim = cosineSim(memberCentered, centerFp(fpR));
    ranked.push({ row: r, sim });
  }
  ranked.sort((a, b) => a.sim - b.sim);
  return ranked.slice(0, 3).map(({ row }) => ({
    title: row.title,
    title_lower: row.title_lower,
    list: row.list,
    network: row.network,
    network_url: row.network_url,
    rating: row.rating,
  }));
}

async function enrichPick(env, p) {
  const genreRow = await env.DB.prepare(
    `SELECT genres FROM shows
     WHERE LOWER(title) = ? AND archived = 0 AND genres IS NOT NULL AND genres != ''
     ORDER BY id LIMIT 1`
  ).bind(p.title_lower).first();
  p.genres = genreRow ? genreRow.genres : null;

  const { results: actors } = await env.DB.prepare(
    `SELECT a.name FROM actors a
     JOIN shows s ON s.id = a.show_id
     WHERE LOWER(s.title) = ? AND s.archived = 0
     GROUP BY a.name
     ORDER BY MIN(a.id)
     LIMIT 5`
  ).bind(p.title_lower).all();
  p.actors = actors.map(a => a.name);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  // Vibe profiles surface taste fingerprints that feel personal — keep it
  // behind a login. Anyone in the club can look at anyone's vibe; logged-out
  // visitors get a 401 and the frontend prompts to log in.
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: corsHeaders(),
    });
  }
  const url = new URL(request.url);
  const memberSlug = url.searchParams.get('member');

  const members = await listEligibleMembers(env);

  if (!memberSlug) {
    return new Response(JSON.stringify({ members, member: null }), { headers: corsHeaders() });
  }

  const memberRow = await env.DB.prepare(
    'SELECT slug, name, first_name, last_initial FROM members WHERE slug = ?'
  ).bind(memberSlug).first();
  if (!memberRow) {
    return new Response(JSON.stringify({ members, member: null, error: 'not_found' }), { status: 404, headers: corsHeaders() });
  }
  if (EXCLUDED_FROM_TASTE.includes(memberSlug)) {
    return new Response(JSON.stringify({ members, member: { slug: memberSlug, excluded: true, name: memberRow.first_name || memberRow.name } }), { headers: corsHeaders() });
  }

  const engaged = await env.DB.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM shows s
       WHERE s.member_slug = ? AND (COALESCE(s.added_by, '') != 'seed' OR s.archived = 1 OR s.updated_at IS NOT NULL)
     ) AS engaged`
  ).bind(memberSlug).first();

  const fnDisplay = (() => {
    const fn = memberRow.first_name || memberRow.name.split(' ')[0];
    const matches = members.filter(m => m.name.startsWith(fn));
    return matches.length > 1 && memberRow.last_initial ? `${fn} ${memberRow.last_initial}` : fn;
  })();

  if (!engaged.engaged) {
    return new Response(JSON.stringify({ members, member: { slug: memberSlug, is_seed_only: true, name: fnDisplay } }), { headers: corsHeaders() });
  }

  const traitCols = TRAIT_NAMES.map(t => `t.${t}`).join(', ');

  const { results: rows } = await env.DB.prepare(
    `SELECT s.list, s.title, s.network, s.network_url, s.rating, t.title_lower, ${traitCols}
     FROM shows s
     LEFT JOIN show_traits t ON LOWER(s.title) = t.title_lower AND (t.unknown_show = 0 OR t.unknown_show IS NULL)
     WHERE s.member_slug = ? AND s.archived = 0`
  ).bind(memberSlug).all();

  const scoredRows = rows.filter(r => r.title_lower != null);
  const fp = computeFingerprint(scoredRows);

  if (!fp) {
    return new Response(JSON.stringify({
      members,
      member: { slug: memberSlug, name: fnDisplay, no_fingerprint: true, active_count: rows.length, scored_count: 0 },
    }), { headers: corsHeaders() });
  }

  const { results: allScored } = await env.DB.prepare(
    `SELECT t.title_lower, t.title, ${traitCols},
       (SELECT s2.network FROM shows s2 WHERE LOWER(s2.title) = t.title_lower AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY s2.id LIMIT 1) AS network,
       (SELECT s2.network_url FROM shows s2 WHERE LOWER(s2.title) = t.title_lower AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY s2.id LIMIT 1) AS network_url,
       (SELECT s2.rating FROM shows s2 WHERE LOWER(s2.title) = t.title_lower AND s2.archived = 0
          AND s2.rating IS NOT NULL ORDER BY s2.id LIMIT 1) AS rating
     FROM show_traits t
     WHERE (t.unknown_show = 0 OR t.unknown_show IS NULL)
       AND EXISTS (
         SELECT 1 FROM shows ss
         WHERE LOWER(ss.title) = t.title_lower
           AND ss.archived = 0
           AND ss.member_slug NOT IN (${EXCLUDED_SQL})
       )`
  ).all();

  const memberTitleSet = new Set(scoredRows.map(r => r.title_lower));
  const picks = alignedPicks(fp, allScored, memberTitleSet);
  const outliers = outlierPicks(fp, scoredRows);

  for (const p of [...picks, ...outliers]) {
    await enrichPick(env, p);
  }

  return new Response(JSON.stringify({
    members,
    member: {
      slug: memberSlug,
      name: fnDisplay,
      active_count: rows.length,
      scored_count: scoredRows.length,
      cluster: pickCluster(fp),
      display_traits: displayTraits(fp),
      balance: balanceMetrics(fp),
      aligned_picks: picks,
      outlier_picks: outliers,
    },
  }), { headers: corsHeaders() });
}
