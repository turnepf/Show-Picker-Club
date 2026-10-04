import { TRAIT_NAMES } from '../_shared/vibe-traits.js';
import { EXCLUDED_FROM_TASTE } from '../_shared/excluded-members.js';
import { getSession } from '../_shared/auth.js';
import {
  LIST_WEIGHT, assignDistinct, centerFp, clubBaseline, computeFingerprint, cosineSim, pickCluster,
} from '../_shared/vibe-match.js';

const EXCLUDED_SQL = EXCLUDED_FROM_TASTE.map(s => `'${s}'`).join(',');

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': 'https://showpicker.club', 'Content-Type': 'application/json' };
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

// Whose vibe you can look at: yourself, plus anyone you share a group with.
// The club roster used to be the answer, which meant the picker listed people
// a member had no relationship with — the same reason the roster came off the
// home screens. Group membership is the relationship the member actually
// chose, so it's the boundary here too.
//
// The taste exclusion (_shared/excluded-members.js) is NOT a visibility rule
// and does not appear in this query. It bounds what the club *computes* from a
// sprawling library — Trending, neighbour pools, the aligned-picks pool below.
// Applying it here made one member invisible in her own picker and unreadable
// to the group-mates she'd chosen, which is a one-way mirror nobody asked for:
// everyone in a group can already open everyone else's library. Group
// membership decides who reads a vibe. Nothing else does.
async function listEligibleMembers(env, viewerSlug) {
  const { results } = await env.DB.prepare(
    `SELECT m.slug, m.name, m.first_name, m.last_initial,
       (SELECT COUNT(*) FROM shows_v s WHERE s.member_slug = m.slug AND s.archived = 0) AS active_count
     FROM members m
     WHERE (m.slug = ?1 OR m.slug IN (
             SELECT gm.member_slug FROM group_members gm
              WHERE gm.group_id IN (SELECT group_id FROM group_members WHERE member_slug = ?1)
           ))
       AND EXISTS (
         SELECT 1 FROM shows_v s
         WHERE s.member_slug = m.slug
           AND (COALESCE(s.added_by, '') != 'seed' OR s.archived = 1 OR s.updated_at IS NOT NULL)
       )
     ORDER BY m.first_name COLLATE NOCASE`
  ).bind(viewerSlug).all();
  const named = disambiguatedNames(results);
  return named.map(m => ({ slug: m.slug, name: m.display, active_count: m.active_count }));
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
  // A representative live copy of this title. The web page renders picks with
  // the shared show card (public/show-renderer.js), which needs the artwork
  // and season data — and an id, so tapping a pick can open the same show
  // detail screen as everywhere else. Prefer a copy that actually has a
  // poster so the card isn't stuck on the placeholder.
  const showRow = await env.DB.prepare(
    `SELECT id, poster_url, movie, seasons_released, full_series, next_season_date
     FROM shows_v
     WHERE LOWER(title) = ? AND archived = 0
     ORDER BY (poster_url IS NULL OR poster_url = ''), id
     LIMIT 1`
  ).bind(p.title_lower).first();
  if (showRow) {
    p.id = showRow.id;
    p.poster_url = showRow.poster_url;
    p.movie = showRow.movie;
    p.seasons_released = showRow.seasons_released;
    p.full_series = showRow.full_series;
    p.next_season_date = showRow.next_season_date;
  }

  const genreRow = await env.DB.prepare(
    `SELECT genres FROM shows_v
     WHERE LOWER(title) = ? AND archived = 0 AND genres IS NOT NULL AND genres != ''
     ORDER BY id LIMIT 1`
  ).bind(p.title_lower).first();
  p.genres = genreRow ? genreRow.genres : null;

  const { results: actors } = await env.DB.prepare(
    `SELECT a.name FROM actors_v a
     JOIN shows_v s ON s.id = a.show_id
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

  const members = await listEligibleMembers(env, session.member_slug);

  // The picker is scoped, so the endpoint is too — otherwise the list is a
  // suggestion and a hand-typed slug still returns a stranger's taste.
  if (memberSlug && memberSlug !== session.member_slug
      && !members.some(m => m.slug === memberSlug)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: corsHeaders() });
  }

  if (!memberSlug) {
    return new Response(JSON.stringify({ members, member: null }), { headers: corsHeaders() });
  }

  const memberRow = await env.DB.prepare(
    'SELECT slug, name, first_name, last_initial FROM members WHERE slug = ?'
  ).bind(memberSlug).first();
  if (!memberRow) {
    return new Response(JSON.stringify({ members, member: null, error: 'not_found' }), { status: 404, headers: corsHeaders() });
  }

  const engaged = await env.DB.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM shows_v s
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
     FROM shows_v s
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
       (SELECT s2.network FROM shows_v s2 WHERE LOWER(s2.title) = t.title_lower AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY s2.id LIMIT 1) AS network,
       (SELECT s2.network_url FROM shows_v s2 WHERE LOWER(s2.title) = t.title_lower AND s2.archived = 0
          AND s2.network IS NOT NULL AND s2.network != ''
          AND s2.network_url IS NOT NULL AND s2.network_url != ''
          AND s2.network_url NOT LIKE '%search%' AND s2.network_url NOT LIKE '%/s?%'
        ORDER BY s2.id LIMIT 1) AS network_url,
       (SELECT s2.rating FROM shows_v s2 WHERE LOWER(s2.title) = t.title_lower AND s2.archived = 0
          AND s2.rating IS NOT NULL ORDER BY s2.id LIMIT 1) AS rating
     FROM show_traits t
     WHERE (t.unknown_show = 0 OR t.unknown_show IS NULL)
       AND EXISTS (
         SELECT 1 FROM shows_v ss
         WHERE LOWER(ss.title) = t.title_lower
           AND ss.archived = 0
           -- The one place the taste exclusion belongs in this file: a
           -- recommendation is a club-level claim ("someone here rates this"),
           -- so a title no unexcluded member holds isn't offered to anyone.
           AND ss.member_slug NOT IN (${EXCLUDED_SQL})
       )`
  ).all();

  // Every member's fingerprint. Two things need them: the club baseline this
  // member is read against (without it the cluster is decided by what all
  // television has in common and nearly everybody comes back the same label),
  // and the group variety rule below. Everyone is fetched — the taste
  // exclusion applies to the baseline, which is club arithmetic, not to who
  // gets a persona.
  const { results: clubRows } = await env.DB.prepare(
    `SELECT s.member_slug, s.list, ${traitCols}
     FROM shows_v s
     JOIN show_traits t ON LOWER(s.title) = t.title_lower AND (t.unknown_show = 0 OR t.unknown_show IS NULL)
     WHERE s.archived = 0`
  ).all();
  const byMember = new Map();
  for (const r of clubRows) {
    if (!byMember.has(r.member_slug)) byMember.set(r.member_slug, []);
    byMember.get(r.member_slug).push(r);
  }
  const fingerprints = new Map();
  for (const [slug, rows] of byMember) {
    const f = computeFingerprint(rows);
    if (f) fingerprints.set(slug, f);
  }
  const baseline = clubBaseline(
    [...fingerprints.entries()]
      .filter(([slug]) => !EXCLUDED_FROM_TASTE.includes(slug))
      .map(([, f]) => f)
  );

  // Nobody in a group shares a persona while there are personas left — the
  // comparison is the fun, and it dies if half the group reads the same. The
  // assignment is computed over the member's largest group (ties to the oldest)
  // so it doesn't depend on who is looking: everyone sees the same label for
  // the same person.
  const { results: groupPeers } = await env.DB.prepare(
    `SELECT gm.member_slug
       FROM group_members gm
      WHERE gm.group_id = (
        SELECT g.group_id FROM group_members g
          WHERE g.member_slug = ?1
          ORDER BY (SELECT COUNT(*) FROM group_members c WHERE c.group_id = g.group_id) DESC,
                   g.group_id ASC
          LIMIT 1
      )`
  ).bind(memberSlug).all();
  const assignment = assignDistinct(
    groupPeers.map(p => ({
      slug: p.member_slug,
      fp: fingerprints.get(p.member_slug) || null,
      scoredTitles: (byMember.get(p.member_slug) || []).length,
    })),
    baseline
  );

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
      cluster: pickCluster(fp, baseline, {
        scoredTitles: scoredRows.length,
        preferId: assignment.get(memberSlug) || null,
      }),
      display_traits: displayTraits(fp),
      balance: balanceMetrics(fp),
      aligned_picks: picks,
      outlier_picks: outliers,
    },
  }), { headers: corsHeaders() });
}
