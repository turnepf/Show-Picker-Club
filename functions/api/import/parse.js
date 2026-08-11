// POST /api/import/parse — read a slice of a pasted list.
//
// Body: { text: "<the whole paste>", cursor?: <int>, section?: "<carried heading>" }
// Returns: { items: [...], next_cursor: <int|null>, section: "<heading>" }
//
// Writes nothing. The client calls this repeatedly, threading `next_cursor` and
// `section` back in, until `next_cursor` comes back null — then posts the
// accumulated items to /api/import/commit. A paste under ~12k characters
// finishes on the first call, so for a normal list the loop is invisible.
//
// The paging exists because both halves of the work are bounded per
// invocation: one Claude call per slice, and one TMDB search per extracted
// title. Handing a 300-title list to a single request would exhaust the
// subrequest budget and time out long before it finished.

import { getSession } from '../../_shared/auth.js';
import { extractItems, resolveItems, existingTitles, sliceChunk } from '../../_shared/list-parse.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Guard rails on the input itself. Not a cap on list length — the client pages
// through as much text as the member pastes — just a ceiling on one request.
const MAX_TEXT_CHARS = 400000;

export async function onRequestPost(context) {
  const { request, env } = context;
  const session = await getSession(request, env);
  if (!session) return json({ error: 'Unauthorized' }, 401);

  if (!env.ANTHROPIC_API_KEY) return json({ error: 'import_unavailable' }, 503);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return json({ error: 'text required' }, 400);
  if (text.length > MAX_TEXT_CHARS) return json({ error: 'text_too_long' }, 413);

  const cursor = Number.isInteger(body.cursor) ? body.cursor : 0;
  if (cursor < 0 || cursor > text.length) return json({ error: 'bad cursor' }, 400);
  const carriedSection = typeof body.section === 'string' ? body.section.slice(0, 200) : '';

  const { chunk, nextCursor } = sliceChunk(text, cursor);
  if (!chunk) return json({ items: [], next_cursor: null, section: carriedSection });

  let extracted;
  try {
    extracted = await extractItems(env, chunk, carriedSection);
  } catch (e) {
    console.error('[import] extract failed', e.message);
    return json({ error: 'parse_failed', detail: e.message.slice(0, 140) }, 502);
  }

  const existing = await existingTitles(env, session.member_slug);
  const items = await resolveItems(env, extracted.items, existing);

  // Two lines of a paste can name the same show ("Severence" under Watching,
  // "Severance" further down). They resolve to one canonical title, so keep
  // the first and drop the rest rather than offering the member a duplicate
  // row that would fail on insert anyway.
  const seen = new Set();
  const deduped = items.filter(item => {
    const key = item.title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return json({
    items: deduped,
    next_cursor: nextCursor,
    section: extracted.trailingSection,
    // So the client can draw an honest progress bar instead of a spinner that
    // says nothing about how much is left.
    total_chars: text.length,
  });
}
