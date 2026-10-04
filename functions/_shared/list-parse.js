// Turn a pasted list of shows into rows the member can review and add.
//
// Two stages, deliberately split:
//
//   1. Claude reads a slice of the pasted text and extracts structured items —
//      title, which of the four lists it belongs on, and the personal bits
//      (notes, who recommended it, who they watch it with).
//   2. TMDB resolves each extracted title to a real id, canonical spelling,
//      year and poster.
//
// Claude never invents a tmdb_id; it only reads what the member wrote. TMDB is
// the only thing that says a title exists. That split is the whole design —
// a model asked for ids will happily produce plausible ones.
//
// The caller pages through the text with a cursor (see sliceChunk) so a paste
// of any length stays inside the Worker's subrequest and time budget. A normal
// paste finishes on the first call and the loop never visibly runs.

import { searchTmdbTitle } from './enrichment.js';
import { canonicalNetwork } from './networks.js';
import { sameShow } from './same-show.js';

// The four lists, exactly as `shows.list` stores them.
export const LIST_KEYS = ['watching', 'waiting', 'recommending', 'next'];

// Where a title goes when the paste has no structure to place it, absent a
// caller saying otherwise. Patrick's call (2026-08): an undifferentiated list
// is most often "stuff I'm watching", and Watching is where the app expects
// you to triage from. Note this feeds the calendar
// (functions/calendar/[slug].js selects watching + waiting), so an
// unstructured import does show up in a subscribed feed — the review screen
// is what keeps that honest.
//
// It is only the fallback's fallback. The caller passes the list the member
// was looking at when they opened the importer (see normalizeList), because
// the same unstructured paste means different things from different places:
// a bare list of titles opened from Next Up is a watchlist, not a confession
// that they're mid-season on forty shows. Headings in the text still win over
// both.
export const DEFAULT_LIST = 'watching';

// A caller-supplied default is untrusted input; anything that isn't one of the
// four keys falls back rather than reaching Claude or a `shows.list` column.
export function normalizeList(value) {
  return LIST_KEYS.includes(value) ? value : DEFAULT_LIST;
}

// Characters of pasted text handed to one Claude call. Sized so the extracted
// items comfortably fit the response and so the TMDB resolution below stays
// well inside a Worker invocation's subrequest budget.
const CHUNK_CHARS = 12000;

// TMDB lookups run in waves rather than all at once — 40 simultaneous fetches
// from one invocation is a good way to get rate-limited by TMDB.
const RESOLVE_CONCURRENCY = 8;

// Claude Opus 5. Thinking is on by default on this model and `effort` is the
// lever, not disabling it: extraction is a scoped, latency-sensitive task, so
// low effort keeps a paste feeling instant while the model still reads the
// whole slice.
const CLAUDE_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You extract TV shows and movies from a list a person pasted in, so their tracking app can add them.

The app keeps four lists. Put every title on exactly one:

- "watching" — currently watching, in progress, partway through a season.
- "waiting" — caught up and waiting on the next season or episode.
- "recommending" — favourites, all-time greats, things they loved or push on other people.
- "next" — a watchlist: things they mean to get to but have not started.

Read the whole slice before deciding. Headings, all-caps lines, lines ending in a colon, emoji dividers and blank-line groupings usually mark sections — apply a section's meaning to every title under it until the next heading. A line like "waiting on s3" next to one title only affects that title.

You are also given the heading that was in effect at the end of the previous slice, since the text is processed in pieces. If the slice begins with titles and no heading of its own, they belong to that carried-over section.

When nothing in the text places a title, use the fallback list named in the message below. Only fall back when the text really is silent about where a title goes — a heading, a section, or a remark next to the title always wins over the fallback.

For each title, also pull out what the person wrote around it:

- notes — their own remark about the show, cleaned up but not reworded. "s2 in january", "everyone says it gets good after ep 4", "half watched". Do not invent a note, do not describe the show yourself, and do not repeat the title, the streaming service, or the section heading here.
- network — the streaming service or channel, if they named one ("on Hulu", "Netflix", "AppleTV+").
- recommended_by — a person they credit for the recommendation ("Quinn told me about this", "per Mom", "rec by Sarah").
- watching_with — a person they watch it with ("with Rosa", "me and Kate").
- year — a release year, only when they wrote one or it is needed to tell two same-named titles apart.
- movie — true for a film, false for a series. Guess from the title when they did not say.

Rules:

- Extract only real titles. Skip headings, commentary, dates, episode counts, URLs, ratings, and anything that is not the name of a show or film.
- Give the title as written, corrected for obvious typos and casing. Do not translate it, do not append the year, and do not add a subtitle they did not write.
- One entry per title. If a title appears twice, keep the entry with more detail.
- Never invent a title that is not in the text. An empty list is a fine answer for a slice that has none.
- Leave a string field as "" when the text does not supply it. Never guess a person's name.

Finally, report trailing_section: the heading in effect at the very end of this slice, so the next slice can continue under it. Use "" if the slice ends outside any section.`;

// Cut the next slice of pasted text at a line boundary.
//
// Cutting mid-line would split a title in half; worse, cutting a section away
// from its heading silently reclassifies everything under it — which is why
// the caller also threads `trailing_section` from one call to the next.
export function sliceChunk(text, cursor) {
  const start = Math.max(0, Math.min(cursor | 0, text.length));
  if (start >= text.length) return { chunk: '', nextCursor: null };
  if (text.length - start <= CHUNK_CHARS) {
    return { chunk: text.slice(start), nextCursor: null };
  }
  const hardEnd = start + CHUNK_CHARS;
  const lastBreak = text.lastIndexOf('\n', hardEnd);
  // A single line longer than the chunk size has no break to cut at; take the
  // hard cut rather than looping forever on the same cursor.
  const end = lastBreak > start ? lastBreak + 1 : hardEnd;
  return { chunk: text.slice(start, end), nextCursor: end };
}

const ITEM_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    year: { type: 'string' },
    list: { type: 'string', enum: LIST_KEYS },
    notes: { type: 'string' },
    network: { type: 'string' },
    recommended_by: { type: 'string' },
    watching_with: { type: 'string' },
    movie: { type: 'boolean' },
  },
  required: ['title', 'year', 'list', 'notes', 'network', 'recommended_by', 'watching_with', 'movie'],
  additionalProperties: false,
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    items: { type: 'array', items: ITEM_SCHEMA },
    trailing_section: { type: 'string' },
  },
  required: ['items', 'trailing_section'],
  additionalProperties: false,
};

async function callClaude(env, chunk, carriedSection, defaultList) {
  const userMsg = [
    carriedSection
      ? `Heading in effect at the end of the previous slice: ${carriedSection}`
      : 'This is the start of the list.',
    // Per-request, so it rides in the user turn rather than the system prompt:
    // the system prompt is cached ephemeral and stays byte-identical across
    // every slice of every import, which a four-way interpolation would break.
    `Fallback list for titles the text does not place: ${defaultList}`,
    '',
    'Pasted list:',
    chunk,
  ].join('\n');

  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      // The system prompt is byte-identical on every slice of every import, so
      // a paste that pages caches it once and reads it back on each later call.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      // Schema-constrained output: the response is valid JSON in this shape or
      // the request fails, so there is no prose to scrape and no fenced-code
      // stripping to get wrong.
      output_config: {
        effort: 'low',
        format: { type: 'json_schema', schema: RESPONSE_SCHEMA },
      },
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
}

// One Claude call for one slice. Returns the raw extracted items — unresolved,
// unvalidated beyond the schema.
export async function extractItems(env, chunk, carriedSection, defaultList = DEFAULT_LIST) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const fallback = normalizeList(defaultList);

  let res = await callClaude(env, chunk, carriedSection, fallback);
  // Same 429 handling as the vibe filler: read Retry-After, sleep, try once more.
  if (res.status === 429) {
    const ra = parseInt(res.headers.get('retry-after') || '10', 10);
    await new Promise(r => setTimeout(r, Math.min(Math.max(ra * 1000, 2000), 30000)));
    res = await callClaude(env, chunk, carriedSection, fallback);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Claude API ${res.status}: ${body.slice(0, 200)}`);
  }

  const body = await res.json();
  if (body.stop_reason === 'refusal') {
    throw new Error('Claude declined to read this list');
  }
  const text = (body.content || []).filter(c => c.type === 'text').map(c => c.text || '').join('');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { throw new Error(`Bad JSON from Claude: ${text.slice(0, 120)}`); }

  return {
    items: Array.isArray(parsed.items) ? parsed.items : [],
    trailingSection: typeof parsed.trailing_section === 'string' ? parsed.trailing_section : '',
  };
}

function blank(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Resolve extracted titles against TMDB and flag the ones the member already
// has. Runs in waves of RESOLVE_CONCURRENCY.
export async function resolveItems(env, rawItems, existingByTitle, defaultList = DEFAULT_LIST) {
  const fallback = normalizeList(defaultList);
  const out = [];
  for (let i = 0; i < rawItems.length; i += RESOLVE_CONCURRENCY) {
    const wave = rawItems.slice(i, i + RESOLVE_CONCURRENCY);
    const resolved = await Promise.all(wave.map(async (raw) => {
      const title = blank(raw.title);
      if (!title) return null;
      const movie = !!raw.movie;

      let hit = { tmdbId: null, tmdbType: null, canonicalTitle: null, posterUrl: null, releaseYear: null };
      try { hit = await searchTmdbTitle(title, env, movie); }
      catch (_) { /* leave the row unresolved; the member can still add it */ }

      const finalTitle = hit.canonicalTitle || title;
      const network = blank(raw.network);
      const existing = existingByTitle.get({ title: finalTitle, tmdb_id: hit.tmdbId, tmdb_type: hit.tmdbType, movie }) || null;
      const writtenYear = parseInt(blank(raw.year), 10);

      return {
        title: finalTitle,
        // What the member actually typed, so the review row can show that we
        // read "Severence" as "Severance" instead of silently correcting it.
        raw_title: title,
        // Claude is schema-constrained to the four keys, so this is the belt to
        // that braces — and it has to honour the caller's fallback too, or a
        // malformed row would quietly land on Watching from a Next Up import.
        list: LIST_KEYS.includes(raw.list) ? raw.list : fallback,
        notes: blank(raw.notes) || null,
        network: network ? canonicalNetwork(network) : null,
        recommended_by: blank(raw.recommended_by) || null,
        watching_with: blank(raw.watching_with) || null,
        movie: movie ? 1 : 0,
        year: hit.releaseYear || (Number.isInteger(writtenYear) ? writtenYear : null),
        tmdb_id: hit.tmdbId,
        tmdb_type: hit.tmdbType,
        poster_url: hit.posterUrl,
        // Unmatched titles are kept, not dropped — TMDB misses real things,
        // and the member is about to look at every row anyway.
        matched: !!hit.tmdbId,
        // Already on one of their lists: the review screen shows which, and
        // leaves the row unchecked by default.
        existing_list: existing ? existing.list : null,
        existing_archived: existing ? !!existing.archived : false,
      };
    }));
    for (const r of resolved) if (r) out.push(r);
  }
  return out;
}

// Every active + archived show the member already has, so a whole import
// dupe-checks in one query instead of one per title. Matched with sameShow:
// by TMDB entry when both sides are pinned, else by title — owning one of
// three films called "The Odyssey" doesn't flag the other two.
export async function existingTitles(env, memberSlug) {
  const { results } = await env.DB.prepare(
    'SELECT title, list, archived, tmdb_id, tmdb_type, movie FROM shows_v WHERE member_slug = ?'
  ).bind(memberSlug).all();
  const rows = results || [];
  return {
    get(show) {
      return rows.find((r) => r.tmdb_id && sameShow(r, show)) || rows.find((r) => sameShow(r, show)) || null;
    },
  };
}
