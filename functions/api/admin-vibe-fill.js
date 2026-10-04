import { TRAIT_NAMES, SYSTEM_PROMPT } from '../_shared/vibe-traits.js';
import { isAdmin } from '../_shared/admin.js';
import { cronAuthorized } from '../_shared/secrets.js';
import { showKeySql } from '../_shared/same-show.js';

// The queue is one entry per show — a TMDB entry, or a title TMDB never
// matched — keyed the way title_traits is (migration 081). Three 2026 films
// called "The Odyssey" are three fingerprints, each scored with its own year
// and synopsis so Claude can tell which one it's describing.
const KEY = showKeySql('s');

// The fill queue is every active title in the club, including titles only a
// taste-excluded member holds (_shared/excluded-members.js). `title_traits` is
// a catalog: a row says what a title is like, not whose taste it counts
// towards. Skipping those titles left the excluded member's own vibe computed
// from the sliver of her library somebody else happens to share — the club
// signals that must not see her library filter her out where they read it
// (Trending, the neighbour pool, the aligned-picks candidate pool), not here.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Authorise either an operator session OR a CRON_SECRET header — the
// scheduled GitHub Action uses the latter so it can keep the fill
// queue draining without anyone logged in.
async function authorized(request, env) {
  if (await isAdmin(request, env)) return true;
  return await cronAuthorized(request, env);
}

const CLAUDE_MODEL = 'claude-sonnet-4-6';

async function callClaude(env, userMsg) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
}

async function scoreShow(env, { title, year, overview, genres, network, rating }) {
  const lines = [`Score this show.`, `Title: ${title}`];
  if (year) lines.push(`Year: ${year}`);
  if (overview) lines.push(`Synopsis: ${String(overview).slice(0, 500)}`);
  if (genres) lines.push(`Genres: ${genres}`);
  if (network) lines.push(`Network: ${network}`);
  if (rating) lines.push(`Audience rating: ${rating}/10`);
  const userMsg = lines.join('\n');

  let res = await callClaude(env, userMsg);

  // 429 handling: read Retry-After header, sleep, retry once.
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '30', 10);
    const waitMs = Math.min(Math.max(ra * 1000, 5000), 60000);
    await new Promise(r => setTimeout(r, waitMs));
    res = await callClaude(env, userMsg);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const body = await res.json();
  const text = (body.content || []).map(c => c.text || '').join('').trim();

  // Tolerate wrapping code fences and trailing prose ("Wait, actually …").
  // We expect a flat JSON object so the first {...} balanced on a single
  // brace level is the payload.
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const m = stripped.match(/\{[^{}]*\}/);
  const candidate = m ? m[0] : stripped;

  let parsed;
  try { parsed = JSON.parse(candidate); }
  catch (e) {
    throw new Error(`Bad JSON from Claude: ${candidate.slice(0, 120)}`);
  }
  return parsed;
}

async function getRescoreCursor(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM vibe_state WHERE key = 'rescore_before'"
    ).first();
    return row?.value || null;
  } catch (e) {
    // vibe_state may not exist yet (pre-migration). Treat as no cursor.
    return null;
  }
}

async function setRescoreCursor(env, value) {
  try {
    if (value) {
      await env.DB.prepare(
        `INSERT INTO vibe_state (key, value, updated_at)
         VALUES ('rescore_before', ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      ).bind(value).run();
    } else {
      await env.DB.prepare("DELETE FROM vibe_state WHERE key = 'rescore_before'").run();
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'vibe_state table missing — apply migration 010 first.' };
  }
}

// GET — status snapshot so the page can show "running in background" + a
// remaining count without triggering a Claude call.
export async function onRequestGet(context) {
  const { request, env } = context;
  if (!(await authorized(request, env))) return json({ error: 'Forbidden' }, 403);
  const cursor = await getRescoreCursor(env);
  const fillRemaining = (await env.DB.prepare(`
    SELECT COUNT(DISTINCT ${KEY}) AS cnt FROM shows_v s
    WHERE s.archived = 0
      AND ${KEY} NOT IN (SELECT show_key FROM title_traits)
  `).first())?.cnt ?? 0;
  let rescoreRemaining = 0;
  if (cursor) {
    rescoreRemaining = (await env.DB.prepare(`
      SELECT COUNT(DISTINCT ${KEY}) AS cnt FROM shows_v s
      WHERE s.archived = 0
        AND ${KEY} NOT IN (
          SELECT show_key FROM title_traits
           WHERE scored_at IS NOT NULL AND scored_at >= ?
        )
    `).bind(cursor).first())?.cnt ?? 0;
  }
  return json({
    rescore_active: !!cursor,
    rescore_started_at: cursor,
    fill_remaining: fillRemaining,
    rescore_remaining: rescoreRemaining,
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await authorized(request, env))) return json({ error: 'Forbidden' }, 403);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  // Operator-driven state mutations. These don't need ANTHROPIC_API_KEY
  // because they don't call Claude.
  if (body.action === 'start_background_rescore') {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const res = await setRescoreCursor(env, now);
    if (!res.ok) return json({ error: res.error }, 500);
    return json({ ok: true, rescore_started_at: now });
  }
  if (body.action === 'cancel_background_rescore') {
    const res = await setRescoreCursor(env, null);
    if (!res.ok) return json({ error: res.error }, 500);
    return json({ ok: true });
  }

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  const count = Math.min(parseInt(body.count || '5', 10) || 5, 8);
  // Three ways to enter rescore mode:
  //   1. body.rescore=true + body.before=isoStamp  (foreground, page-driven)
  //   2. body.rescore=true with no before          (foreground, server stamps now)
  //   3. body.rescore not set, but a cursor sits in vibe_state           ←
  //                                                  cron auto-mode
  // The third path is what lets the GitHub Action keep a re-score going
  // after the operator closes the browser.
  let rescore = body.rescore === true || body.rescore === 'true';
  let before = typeof body.before === 'string' ? body.before : null;
  if (!rescore && !before) {
    const stored = await getRescoreCursor(env);
    if (stored) { rescore = true; before = stored; }
  } else if (rescore && !before) {
    before = new Date().toISOString().replace('T', ' ').slice(0, 19);
  }

  let candidateFilter;
  const filterParams = [];
  if (rescore && before) {
    candidateFilter = `AND ${KEY} NOT IN (SELECT show_key FROM title_traits WHERE scored_at IS NOT NULL AND scored_at >= ?)`;
    filterParams.push(before);
  } else if (rescore) {
    candidateFilter = '';
  } else {
    candidateFilter = `AND ${KEY} NOT IN (SELECT show_key FROM title_traits)`;
  }

  const { results: pending } = await env.DB.prepare(`
    SELECT ${KEY} AS show_key,
           MIN(s.title) AS title,
           MAX(s.release_year) AS year,
           MAX(NULLIF(s.overview, '')) AS overview,
           MIN(NULLIF(s.genres, '')) AS genres,
           MIN(NULLIF(s.network, '')) AS network,
           MAX(NULLIF(s.rating, '')) AS rating
    FROM shows_v s
    WHERE s.archived = 0
      ${candidateFilter}
    GROUP BY ${KEY}
    ORDER BY LOWER(MIN(s.title)), ${KEY}
    LIMIT ?
  `).bind(...filterParams, count).all();

  const remaining = await env.DB.prepare(`
    SELECT COUNT(DISTINCT ${KEY}) AS cnt FROM shows_v s
    WHERE s.archived = 0
      ${candidateFilter}
  `).bind(...filterParams).first();

  const results = [];
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    try {
      const traits = await scoreShow(env, row);

      if (traits.unknown_show) {
        await env.DB.prepare(
          'INSERT OR REPLACE INTO title_traits (show_key, title, unknown_show, scored_at) VALUES (?, ?, 1, datetime(\'now\'))'
        ).bind(row.show_key, row.title).run();
        results.push({ title: row.title, status: 'unknown' });
        continue;
      }

      const cols = ['show_key', 'title', ...TRAIT_NAMES, 'scored_at'];
      const placeholders = cols.map(c => c === 'scored_at' ? "datetime('now')" : '?').join(', ');
      const values = [
        row.show_key,
        row.title,
        ...TRAIT_NAMES.map(t => {
          const v = traits[t];
          return typeof v === 'number' && v >= 0 && v <= 1 ? v : 0.5;
        }),
      ];
      await env.DB.prepare(
        `INSERT OR REPLACE INTO title_traits (${cols.join(', ')}) VALUES (${placeholders})`
      ).bind(...values).run();
      results.push({ title: row.title, status: 'ok' });
    } catch (e) {
      results.push({ title: row.title, status: 'error', error: String(e).slice(0, 200) });
    }
  }

  const remainingCount = remaining
    ? remaining.cnt - results.filter(r => r.status !== 'error').length
    : 0;

  // If we just ran rescore mode against a stored cursor and have caught
  // up, clear the cursor so the cron stops trying. Foreground rescore
  // (page-driven, body.before passed explicitly) doesn't touch state.
  if (rescore && remainingCount <= 0 && !body.before) {
    await setRescoreCursor(env, null);
  }

  return json({
    processed: results.filter(r => r.status === 'ok').length,
    unknown: results.filter(r => r.status === 'unknown').length,
    errors: results.filter(r => r.status === 'error').length,
    remaining: remainingCount,
    mode: rescore ? 'rescore' : 'fill',
    rescore_cursor: rescore ? before : null,
    results,
  });
}
