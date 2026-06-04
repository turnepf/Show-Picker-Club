import { TRAIT_NAMES, SYSTEM_PROMPT } from '../_shared/vibe-traits.js';
import { EXCLUDED_FROM_TASTE } from '../_shared/excluded-members.js';
import { isAdmin } from '../_shared/admin.js';

const EXCLUDED_SQL = EXCLUDED_FROM_TASTE.map(s => `'${s}'`).join(',');

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

async function scoreShow(env, title, genres, network, rating) {
  const lines = [`Score this show.`, `Title: ${title}`];
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

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!(await isAdmin(request, env))) return json({ error: 'Forbidden — log in as the operator' }, 403);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ANTHROPIC_API_KEY not configured' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const count = Math.min(parseInt(body.count || '5', 10) || 5, 8);
  // Default behaviour: score titles that don't yet have a row in show_traits.
  // With rescore=true the operator forces a fresh score across every
  // eligible title — useful when the prompt or model improves and we
  // want to refresh the existing reports. The client passes `before` as
  // the timestamp it started the rescore at; we keep picking titles whose
  // last scored_at predates that cursor, so the loop terminates once
  // everything has been refreshed in this run.
  const rescore = body.rescore === true || body.rescore === 'true';
  const before = typeof body.before === 'string' ? body.before : null;

  let candidateFilter;
  let remainingFilter;
  const filterParams = [];
  const remainingParams = [];
  if (rescore && before) {
    candidateFilter = `AND (LOWER(s.title) NOT IN (SELECT title_lower FROM show_traits WHERE scored_at IS NOT NULL AND scored_at >= ?))`;
    remainingFilter = `AND (LOWER(title) NOT IN (SELECT title_lower FROM show_traits WHERE scored_at IS NOT NULL AND scored_at >= ?))`;
    filterParams.push(before);
    remainingParams.push(before);
  } else if (rescore) {
    candidateFilter = '';
    remainingFilter = '';
  } else {
    candidateFilter = 'AND LOWER(s.title) NOT IN (SELECT title_lower FROM show_traits)';
    remainingFilter = 'AND LOWER(title) NOT IN (SELECT title_lower FROM show_traits)';
  }

  const { results: pending } = await env.DB.prepare(`
    SELECT LOWER(s.title) AS title_lower,
           MIN(s.title) AS title,
           (SELECT genres FROM shows g
              WHERE LOWER(g.title) = LOWER(s.title) AND g.genres IS NOT NULL AND g.genres != ''
              ORDER BY g.id LIMIT 1) AS genres,
           (SELECT network FROM shows g
              WHERE LOWER(g.title) = LOWER(s.title) AND g.network IS NOT NULL AND g.network != ''
              ORDER BY g.id LIMIT 1) AS network,
           (SELECT rating FROM shows g
              WHERE LOWER(g.title) = LOWER(s.title) AND g.rating IS NOT NULL AND g.rating != ''
              ORDER BY g.id LIMIT 1) AS rating
    FROM shows s
    WHERE s.archived = 0
      AND s.member_slug NOT IN (${EXCLUDED_SQL})
      ${candidateFilter}
    GROUP BY LOWER(s.title)
    ORDER BY LOWER(s.title)
    LIMIT ?
  `).bind(...filterParams, count).all();

  const remaining = await env.DB.prepare(`
    SELECT COUNT(*) AS cnt FROM (
      SELECT LOWER(title) AS t FROM shows
      WHERE archived = 0
        AND member_slug NOT IN (${EXCLUDED_SQL})
        ${remainingFilter}
      GROUP BY LOWER(title)
    )
  `).bind(...remainingParams).first();

  const results = [];
  for (let i = 0; i < pending.length; i++) {
    const row = pending[i];
    if (i > 0) await new Promise(r => setTimeout(r, 1500));
    try {
      const traits = await scoreShow(env, row.title, row.genres || '', row.network || '', row.rating || '');

      if (traits.unknown_show) {
        await env.DB.prepare(
          'INSERT OR REPLACE INTO show_traits (title_lower, title, unknown_show, scored_at) VALUES (?, ?, 1, datetime(\'now\'))'
        ).bind(row.title_lower, row.title).run();
        results.push({ title: row.title, status: 'unknown' });
        continue;
      }

      const cols = ['title_lower', 'title', ...TRAIT_NAMES, 'scored_at'];
      const placeholders = cols.map(c => c === 'scored_at' ? "datetime('now')" : '?').join(', ');
      const values = [
        row.title_lower,
        row.title,
        ...TRAIT_NAMES.map(t => {
          const v = traits[t];
          return typeof v === 'number' && v >= 0 && v <= 1 ? v : 0.5;
        }),
      ];
      await env.DB.prepare(
        `INSERT OR REPLACE INTO show_traits (${cols.join(', ')}) VALUES (${placeholders})`
      ).bind(...values).run();
      results.push({ title: row.title, status: 'ok' });
    } catch (e) {
      results.push({ title: row.title, status: 'error', error: String(e).slice(0, 200) });
    }
  }

  return json({
    processed: results.filter(r => r.status === 'ok').length,
    unknown: results.filter(r => r.status === 'unknown').length,
    errors: results.filter(r => r.status === 'error').length,
    remaining: remaining ? remaining.cnt - results.filter(r => r.status !== 'error').length : 0,
    results,
  });
}
