// The tools an AI app gets at /mcp, and how each one reaches the club.
//
// Every tool calls an existing /api handler, in process, with a request that
// carries the member's session (actingAs in _shared/auth.js). None of them
// re-implements a permission: owner-only memos stay owner-only, group reads
// stay group-scoped and the one cross-member write (Watching With) keeps the
// group-mate rule, because the code deciding those things is the same code
// the apps call. What this file adds is only what an AI needs on top:
// friendlier list names, compact results, and a few checks where a handler
// answers "success" for a row that isn't yours (archive, delete), which would
// otherwise tell the model something false.
//
// Deliberately absent (docs/INVARIANTS.md §27): joining a group by invite,
// renaming or deleting a group, household, account deletion, passkeys,
// import, anything admin. Account-shaped actions stay in the app, where a
// person is looking at them.

import * as showsApi from '../api/shows.js';
import * as showApi from '../api/shows/[id].js';
import * as moveApi from '../api/shows/[id]/move.js';
import * as archiveApi from '../api/shows/[id]/archive.js';
import * as ratingApi from '../api/shows/[id]/rating.js';
import * as reorderApi from '../api/shows/reorder.js';
import * as allShowsApi from '../api/shows/all.js';
import * as titleSearchApi from '../api/title-search.js';
import * as popularApi from '../api/popular.js';
import * as groupsApi from '../api/groups.js';
import * as groupApi from '../api/groups/[id].js';
import * as groupInviteApi from '../api/groups/[id]/invite.js';
import * as groupLeaveApi from '../api/groups/[id]/leave.js';
import * as groupTrendingApi from '../api/groups/[id]/trending.js';
import * as suggestionsApi from '../api/groups/[id]/suggestions.js';
import * as suggestionApi from '../api/groups/[id]/suggestions/[sid].js';
import { actingAs } from './auth.js';
import { groupMates } from './watchers.js';

// Per member per UTC day. Only changes and TMDB-backed searches are capped:
// reads are D1-only and cost the operator nothing upstream, and a cap that
// counts them is what stopped bulk work (rating a hundred shows reads as well
// as writes). The write ceiling is set for that bulk work and is overridable
// with MCP_DAILY_WRITE_LIMIT; the search ceiling stays low because every
// search spends on the TMDB key. Adding a show carries the app's own
// 50-a-day cap on top (functions/api/shows.js).
export const DAILY_CAPS = { writes: 1000, searches: 100 };

// The caps in force for this deployment. A missing, non-numeric or
// non-positive MCP_DAILY_WRITE_LIMIT falls back to the default rather than
// reading as zero, which would refuse every change.
export function dailyCaps(env) {
  const n = Number.parseInt(env && env.MCP_DAILY_WRITE_LIMIT, 10);
  return { ...DAILY_CAPS, writes: Number.isFinite(n) && n > 0 ? n : DAILY_CAPS.writes };
}

// The API's list keys predate the names members see. Tools speak the names.
export const LIST_TO_API = { watching: 'watching', awaiting: 'waiting', loved: 'recommending', next_up: 'next' };
const API_TO_LIST = Object.fromEntries(Object.entries(LIST_TO_API).map(([k, v]) => [v, k]));
const LIST_NAMES = Object.keys(LIST_TO_API);

export class ToolError extends Error {}

function apiList(name) {
  const key = LIST_TO_API[String(name || '').toLowerCase()] || (API_TO_LIST[name] ? name : null);
  if (!key) throw new ToolError(`Unknown list "${name}". Use one of: ${LIST_NAMES.join(', ')}.`);
  return key;
}

function intArg(args, name, { required = true } = {}) {
  const v = args[name];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolError(`${name} is required.`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ToolError(`${name} must be a whole number.`);
  return n;
}

function strArg(args, name, { required = false, max = 2000 } = {}) {
  const v = args[name];
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`${name} is required.`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolError(`${name} must be text.`);
  const t = v.trim();
  if (required && !t) throw new ToolError(`${name} is required.`);
  return t.slice(0, max);
}

// Calls a handler as the member. Nothing leaves the Worker.
async function call(ctx, handler, { method = 'GET', path, query = {}, body, params = {} }) {
  const url = new URL(path, ctx.origin);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined && method !== 'GET') init.body = JSON.stringify(body);
  const request = actingAs(new Request(url, init), ctx.session);
  const res = await handler({ request, env: ctx.env, params, waitUntil: ctx.waitUntil, data: {} });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

function failure(status, data, what = 'That') {
  const code = data && data.error;
  if (status === 404) return new ToolError(`${what} wasn't found, or isn't yours.`);
  if (status === 403) return new ToolError(typeof code === 'string' && code !== 'Forbidden' ? code : `You don't have access to ${what.toLowerCase()}.`);
  if (status === 429) return new ToolError('The app’s own daily limit for this action has been reached. Try again tomorrow.');
  return new ToolError(typeof code === 'string' ? code : `Request failed (${status}).`);
}

async function ok(ctx, handler, opts, what) {
  const r = await call(ctx, handler, opts);
  if (r.status >= 400) throw failure(r.status, r.data, what);
  return r.data;
}

function parseJsonArray(v) {
  if (Array.isArray(v)) return v;
  try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

// What a model needs about a row, without the artwork URLs and enrichment
// bookkeeping that make a full row several times longer.
function compactShow(s, { detail = false } = {}) {
  const out = {
    id: s.id,
    title: s.title,
    list: API_TO_LIST[s.list] || s.list || undefined,
    type: s.movie ? 'movie' : 'tv',
    network: s.network || undefined,
    release_year: s.release_year || undefined,
    genres: s.genres || undefined,
    club_rating: s.rating || undefined,
    your_rating: s.user_rating ?? undefined,
    seasons_released: s.seasons_released ?? undefined,
    next_episode_date: s.next_season_date || undefined,
    archived: s.archived ? true : undefined,
    // Present only on the member's own rows — the handler strips them
    // everywhere else, and this passes along whatever it was given.
    notes: s.notes || undefined,
    recommended_by: s.recommended_by || undefined,
    watching_with: s.watching_with || undefined,
    watching_with_members: Array.isArray(s.watchers) && s.watchers.length ? s.watchers : undefined,
    // Whose copy it is, in the one read that mixes libraries (search).
    owner: s.member_name || undefined,
  };
  if (detail) {
    Object.assign(out, {
      overview: s.overview || undefined,
      runtime_minutes: s.runtime || undefined,
      content_rating: s.content_rating || undefined,
      director_or_creator: s.director || undefined,
      streaming_on: s.streaming_on || undefined,
      watch_url: s.network_url || undefined,
      tmdb_id: s.tmdb_id || undefined,
      cast: parseJsonArray(s.actors).map((a) => a && a.name).filter(Boolean).slice(0, 10),
    });
  }
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

async function ownsShow(ctx, id) {
  return !!(await ctx.env.DB.prepare('SELECT 1 FROM shows WHERE id = ? AND member_slug = ?')
    .bind(id, ctx.session.member_slug).first());
}

const listSchema = { type: 'string', enum: LIST_NAMES, description: 'watching, awaiting (between seasons), loved (finished and recommended), or next_up (want to watch)' };
// A page of a list: `limit` rows starting at `offset`, plus what's needed to
// ask for the next one. A keen member's library runs to hundreds of titles,
// and the directory review asks for responses sized to the request.
const PAGE_DEFAULT = 100;
const PAGE_MAX = 250;
const pageSchema = {
  limit: { type: 'integer', minimum: 1, maximum: PAGE_MAX, description: `Shows per page. Default ${PAGE_DEFAULT}.` },
  offset: { type: 'integer', minimum: 0, description: 'Skip this many shows (for the next page). Default 0.' },
};
function page(rows, args) {
  const limit = Math.min(Math.max(intArg(args, 'limit', { required: false }) || PAGE_DEFAULT, 1), PAGE_MAX);
  const offset = Math.max(intArg(args, 'offset', { required: false }) || 0, 0);
  const slice = rows.slice(offset, offset + limit);
  return {
    total: rows.length,
    offset,
    ...(offset + slice.length < rows.length ? { next_offset: offset + slice.length } : {}),
    shows: slice.map((s) => compactShow(s)),
  };
}

const R = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

// ---- the tools ---------------------------------------------------------

export const TOOLS = [
  {
    name: 'get_profile',
    title: 'Who am I',
    description: 'The Show Picker Club member this connection acts as: name, slug, list counts, groups, and what this connection is allowed to do.',
    scope: 'shows:read',
    annotations: R,
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      const { shows } = await ok(ctx, showsApi.onRequestGet, { path: '/api/shows', query: { member: ctx.session.member_slug } });
      const counts = Object.fromEntries(LIST_NAMES.map((l) => [l, 0]));
      for (const s of shows || []) if (API_TO_LIST[s.list]) counts[API_TO_LIST[s.list]]++;
      const { groups } = await ok(ctx, groupsApi.onRequestGet, { path: '/api/groups' });
      return {
        slug: ctx.session.member_slug,
        name: ctx.session.email,
        profile_url: `${ctx.origin}/${ctx.session.member_slug}`,
        list_counts: counts,
        groups: (groups || []).map((g) => ({ id: g.id, name: g.name, members: g.member_count })),
        permissions: ctx.scopes,
      };
    },
  },
  {
    name: 'list_my_shows',
    title: 'List my shows',
    description: 'Your own shows in list order, optionally one list only, a page at a time (next_offset is present when there are more). Includes your private notes, who recommended each show, and who you watch it with.',
    scope: 'shows:read',
    annotations: R,
    inputSchema: {
      type: 'object',
      properties: {
        list: listSchema,
        include_archived: { type: 'boolean', description: 'Also include shows you archived. Default false.' },
        ...pageSchema,
      },
    },
    async run(ctx, args) {
      const want = args.list ? apiList(args.list) : null;
      const { shows } = await ok(ctx, showsApi.onRequestGet, {
        path: '/api/shows',
        query: { member: ctx.session.member_slug, include_archived: args.include_archived ? '1' : undefined },
      });
      const rows = (shows || []).filter((s) => !want || s.list === want)
        .sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9) || String(a.title).localeCompare(String(b.title)));
      return page(rows, args);
    },
  },
  {
    name: 'get_show',
    title: 'Show details',
    description: 'Full details for one show by id: overview, cast, where it streams, ratings, and — if it is your own copy — your notes. Also names group-mates who are watching it too.',
    scope: 'shows:read',
    annotations: R,
    inputSchema: { type: 'object', properties: { show_id: { type: 'integer' } }, required: ['show_id'] },
    async run(ctx, args) {
      const id = intArg(args, 'show_id');
      const data = await ok(ctx, showApi.onRequestGet, { path: `/api/shows/${id}`, params: { id: String(id) } }, 'That show');
      return {
        show: compactShow(data.show, { detail: true }),
        is_yours: data.show.member_slug === ctx.session.member_slug,
        ratings: data.ratings || undefined,
        group_mates_also_watching: (data.group_watchers || []).map((w) => w.name),
      };
    },
  },
  {
    name: 'list_member_shows',
    title: "A group-mate's shows",
    description: "The shows on a group-mate's lists, a page at a time: titles and catalog facts, without their private notes. Available only for people you share a private group with; get_group lists their slugs.",
    scope: 'shows:read',
    annotations: R,
    inputSchema: {
      type: 'object',
      properties: { member_slug: { type: 'string' }, list: listSchema, ...pageSchema },
      required: ['member_slug'],
    },
    async run(ctx, args) {
      const slug = strArg(args, 'member_slug', { required: true, max: 64 }).toLowerCase();
      if (slug === ctx.session.member_slug) return TOOLS_BY_NAME.list_my_shows.run(ctx, { list: args.list, limit: args.limit, offset: args.offset });
      // Narrower than the app on purpose: a connection gets no roster, so the
      // only people it can name are the ones it can see through groups.
      const mates = await groupMates(ctx.env, ctx.session.member_slug);
      if (!mates.some((m) => m.slug === slug)) {
        throw new ToolError('You can only see the lists of people you share a private group with.');
      }
      const want = args.list ? apiList(args.list) : null;
      const { shows } = await ok(ctx, showsApi.onRequestGet, { path: '/api/shows', query: { member: slug } });
      const rows = (shows || []).filter((s) => !want || s.list === want);
      return { member: slug, ...page(rows, args) };
    },
  },
  {
    name: 'search_libraries',
    title: 'Search my groups’ libraries',
    description: "Search the shows on your lists and your group-mates' lists by title, network, genre or cast member. Tells you who has each one and on which list.",
    scope: 'shows:read',
    annotations: R,
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    async run(ctx, args) {
      const q = strArg(args, 'query', { required: true, max: 100 });
      const { shows } = await ok(ctx, allShowsApi.onRequestGet, { path: '/api/shows/all', query: { q, limit: 50 } });
      return { count: (shows || []).length, results: (shows || []).map((s) => compactShow(s)) };
    },
  },
  {
    name: 'search_titles',
    title: 'Find a show or movie',
    description: 'Searches the TMDB catalog for TV shows and movies and returns each match with its tmdb_id, type and year — the identifiers add_show takes to add an exact title rather than a same-named remake.',
    scope: 'shows:read',
    search: true,
    annotations: { ...R, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        type: { type: 'string', enum: ['tv', 'movie'], description: 'Limit to TV or movies. Default: both.' },
      },
      required: ['query'],
    },
    async run(ctx, args) {
      const q = strArg(args, 'query', { required: true, max: 100 });
      const { results } = await ok(ctx, titleSearchApi.onRequestGet, { path: '/api/title-search', query: { q, type: args.type } });
      return { results: (results || []).map((r) => ({ tmdb_id: r.tmdb_id, media_type: r.media_type, title: r.title, year: r.year })) };
    },
  },
  {
    name: 'get_trending',
    title: 'Trending',
    description: 'What the club — or one of your groups — has been adding in the last 30 days, most popular first.',
    scope: 'shows:read',
    annotations: R,
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer', description: 'Trending within one of your groups instead of the whole club.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    async run(ctx, args) {
      const limit = intArg(args, 'limit', { required: false }) || 10;
      const gid = intArg(args, 'group_id', { required: false });
      const data = gid
        ? await ok(ctx, groupTrendingApi.onRequestGet, { path: `/api/groups/${gid}/trending`, query: { limit }, params: { id: String(gid) } }, 'That group')
        : await ok(ctx, popularApi.onRequestGet, { path: '/api/popular', query: { limit } });
      return {
        shows: (data.shows || []).map((s) => ({
          title: s.title, type: s.movie ? 'movie' : 'tv', network: s.network || undefined,
          added_by_count: s.member_count, added_by: s.members && s.members.length ? s.members : undefined,
          genres: s.genres || undefined,
        })),
      };
    },
  },
  {
    name: 'list_groups',
    title: 'My groups',
    description: 'The private groups you belong to.',
    scope: 'shows:read',
    annotations: R,
    inputSchema: { type: 'object', properties: {} },
    async run(ctx) {
      const { groups } = await ok(ctx, groupsApi.onRequestGet, { path: '/api/groups' });
      return {
        groups: (groups || []).map((g) => ({ id: g.id, name: g.name, members: g.member_count, you_created_it: !!g.is_creator })),
      };
    },
  },
  {
    name: 'get_group',
    title: 'Group details',
    description: 'One of your groups: who is in it (with their slugs, for list_member_shows and watching_with_members) and how many shows each has.',
    scope: 'shows:read',
    annotations: R,
    inputSchema: { type: 'object', properties: { group_id: { type: 'integer' } }, required: ['group_id'] },
    async run(ctx, args) {
      const gid = intArg(args, 'group_id');
      const d = await ok(ctx, groupApi.onRequestGet, { path: `/api/groups/${gid}`, params: { id: String(gid) } }, 'That group');
      return {
        id: d.group.id,
        name: d.group.name,
        you_created_it: !!d.is_creator,
        members: (d.members || []).map((m) => ({
          slug: m.slug, name: [m.first_name, m.last_name].filter(Boolean).join(' '),
          shows: m.show_count, watching: m.watching_count,
        })),
        change_notice: d.change_notice || undefined,
      };
    },
  },
  {
    name: 'get_group_recommendations',
    title: 'Group recommendations',
    description: "The Watch Next board for one of your groups: shows group-mates recommended, and whether you've added or dismissed each.",
    scope: 'shows:read',
    annotations: R,
    inputSchema: { type: 'object', properties: { group_id: { type: 'integer' } }, required: ['group_id'] },
    async run(ctx, args) {
      const gid = intArg(args, 'group_id');
      const d = await ok(ctx, suggestionsApi.onRequestGet, { path: `/api/groups/${gid}/suggestions`, params: { id: String(gid) } }, 'That group');
      return { recommendations: d.suggestions || [] };
    },
  },

  // ---- writes ----
  {
    name: 'add_show',
    title: 'Add a show',
    description: 'Adds a show or movie to one of your lists. With a tmdb_id and media_type from search_titles it adds that exact title; with a title alone it adds the best catalog match. Naming group-mates in watching_with_members also puts the show on their list, linked to yours.',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        list: listSchema,
        tmdb_id: { type: 'integer' },
        media_type: { type: 'string', enum: ['tv', 'movie'] },
        notes: { type: 'string', description: 'Private note, only you see it.' },
        recommended_by: { type: 'string', description: 'Who told you about it (private).' },
        watching_with: { type: 'string', description: 'Free text, e.g. "my sister" (private).' },
        watching_with_members: { type: 'array', items: { type: 'string' }, description: 'Slugs of group-mates you watch it with.' },
      },
      required: ['title', 'list'],
    },
    async run(ctx, args) {
      const body = {
        title: strArg(args, 'title', { required: true, max: 200 }),
        list: apiList(args.list),
        notes: strArg(args, 'notes'),
        recommended_by: strArg(args, 'recommended_by', { max: 200 }),
        watching_with: strArg(args, 'watching_with', { max: 200 }),
      };
      const tmdbId = intArg(args, 'tmdb_id', { required: false });
      if (tmdbId && args.media_type) { body.tmdb_id = tmdbId; body.tmdb_type = args.media_type; }
      if (args.media_type === 'movie') body.movie = 1;
      if (Array.isArray(args.watching_with_members)) body.watcher_slugs = args.watching_with_members.map(String);
      const r = await call(ctx, showsApi.onRequestPost, { method: 'POST', path: '/api/shows', body });
      if (r.status === 409 && r.data.error === 'exists_active') {
        throw new ToolError(`"${r.data.title}" is already on your ${API_TO_LIST[r.data.list] || r.data.list} list.`);
      }
      if (r.status === 409 && r.data.error === 'exists_archived') {
        throw new ToolError(`"${r.data.title}" is in your archive (show_id ${r.data.id}). Use restore_show to bring it back.`);
      }
      if (r.status >= 400) throw failure(r.status, r.data);
      return { added: compactShow(r.data.show) };
    },
  },
  {
    name: 'update_show',
    title: 'Edit a show',
    description: "Edit one of your shows: private notes, who recommended it, who you watch it with. Only the fields you pass change. watching_with_members replaces the full set of linked group-mates.",
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        show_id: { type: 'integer' },
        notes: { type: 'string' },
        recommended_by: { type: 'string' },
        watching_with: { type: 'string' },
        watching_with_members: { type: 'array', items: { type: 'string' } },
      },
      required: ['show_id'],
    },
    async run(ctx, args) {
      const id = intArg(args, 'show_id');
      const body = {};
      for (const k of ['notes', 'recommended_by', 'watching_with']) {
        if (args[k] !== undefined) body[k] = strArg(args, k) || null;
      }
      if (Array.isArray(args.watching_with_members)) body.watcher_slugs = args.watching_with_members.map(String);
      if (!Object.keys(body).length) throw new ToolError('Pass at least one field to change.');
      const d = await ok(ctx, showApi.onRequestPut, { method: 'PUT', path: `/api/shows/${id}`, body, params: { id: String(id) } }, 'That show');
      return { updated: compactShow(d.show) };
    },
  },
  {
    name: 'move_show',
    title: 'Move a show',
    description: 'Move one of your shows to another list (e.g. next_up → watching when you start it, watching → loved when you finish).',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { show_id: { type: 'integer' }, list: listSchema }, required: ['show_id', 'list'] },
    async run(ctx, args) {
      const id = intArg(args, 'show_id');
      const d = await ok(ctx, moveApi.onRequestPut, { method: 'PUT', path: `/api/shows/${id}/move`, body: { list: apiList(args.list) }, params: { id: String(id) } }, 'That show');
      return { moved: compactShow(d.show) };
    },
  },
  {
    name: 'reorder_list',
    title: 'Reorder a list',
    description: "Set the order of one of your lists. Pass that list's show ids top to bottom; ids not on the list are ignored.",
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { list: listSchema, show_ids: { type: 'array', items: { type: 'integer' } } },
      required: ['list', 'show_ids'],
    },
    async run(ctx, args) {
      const d = await ok(ctx, reorderApi.onRequestPost, {
        method: 'POST', path: '/api/shows/reorder',
        body: { list: apiList(args.list), ids: Array.isArray(args.show_ids) ? args.show_ids : [] },
      });
      return { reordered: d.updated };
    },
  },
  {
    name: 'rate_show',
    title: 'Rate a show',
    description: "Rate one of your shows 1–10, overall or for one season. Not available for Next Up shows (you haven't watched them yet).",
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        show_id: { type: 'integer' },
        rating: { type: 'integer', minimum: 1, maximum: 10 },
        season: { type: 'integer', minimum: 1, description: 'Omit for an overall rating.' },
      },
      required: ['show_id', 'rating'],
    },
    async run(ctx, args) {
      const id = intArg(args, 'show_id');
      const r = await call(ctx, ratingApi.onRequestPut, {
        method: 'PUT', path: `/api/shows/${id}/rating`, params: { id: String(id) },
        body: { rating: intArg(args, 'rating'), season: intArg(args, 'season', { required: false }) ?? null },
      });
      if (r.status === 409 && r.data.error === 'not_watched') throw new ToolError("Shows on Next Up can't be rated until you've started watching them.");
      if (r.status === 409 && r.data.error === 'not_enriched') throw new ToolError("This show hasn't been matched to the catalog yet, so it can't be rated. Try again later.");
      if (r.status >= 400) throw failure(r.status, r.data, 'That show');
      return { ratings: r.data.ratings };
    },
  },
  {
    name: 'archive_show',
    title: 'Archive a show',
    description: 'Takes one of your shows off your lists but keeps it in your history; restore_show brings it back.',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { show_id: { type: 'integer' } }, required: ['show_id'] },
    async run(ctx, args) {
      const id = intArg(args, 'show_id');
      // The handler answers success whether or not the row is yours.
      if (!(await ownsShow(ctx, id))) throw new ToolError("That show wasn't found, or isn't yours.");
      await ok(ctx, archiveApi.onRequestPut, { method: 'PUT', path: `/api/shows/${id}/archive`, params: { id: String(id) } }, 'That show');
      return { archived: id };
    },
  },
  {
    name: 'restore_show',
    title: 'Restore an archived show',
    description: 'Bring one of your archived shows back, onto the list it was on or the one you name.',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { show_id: { type: 'integer' }, list: listSchema }, required: ['show_id'] },
    async run(ctx, args) {
      const id = intArg(args, 'show_id');
      const body = { archived: 0 };
      if (args.list) body.list = apiList(args.list);
      const d = await ok(ctx, showApi.onRequestPut, { method: 'PUT', path: `/api/shows/${id}`, body, params: { id: String(id) } }, 'That show');
      return { restored: compactShow(d.show) };
    },
  },
  {
    name: 'delete_show',
    title: 'Delete a show',
    description: 'Permanently deletes one of your shows and its notes. Cannot be undone; archive_show is the reversible alternative.',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { show_id: { type: 'integer' } }, required: ['show_id'] },
    async run(ctx, args) {
      const id = intArg(args, 'show_id');
      if (!(await ownsShow(ctx, id))) throw new ToolError("That show wasn't found, or isn't yours.");
      await ok(ctx, showApi.onRequestDelete, { method: 'DELETE', path: `/api/shows/${id}`, params: { id: String(id) } }, 'That show');
      return { deleted: id };
    },
  },
  {
    name: 'recommend_to_group',
    title: 'Recommend to a group',
    description: "Put one of your shows on a group's Watch Next board, with an optional note. Nobody's lists change — each group-mate decides whether to add it.",
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'integer' }, show_id: { type: 'integer' }, note: { type: 'string' } },
      required: ['group_id', 'show_id'],
    },
    async run(ctx, args) {
      const gid = intArg(args, 'group_id');
      const d = await ok(ctx, suggestionsApi.onRequestPost, {
        method: 'POST', path: `/api/groups/${gid}/suggestions`, params: { id: String(gid) },
        body: { show_id: intArg(args, 'show_id'), note: strArg(args, 'note', { max: 500 }) },
      }, 'That group or show');
      return { recommendation: d.suggestion };
    },
  },
  {
    name: 'respond_to_recommendation',
    title: 'Answer a group recommendation',
    description: "Answer a card on a group's Watch Next board: 'add' puts it on your Next Up list, 'dismiss' hides it for you only.",
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        group_id: { type: 'integer' },
        recommendation_id: { type: 'integer' },
        response: { type: 'string', enum: ['add', 'dismiss'] },
      },
      required: ['group_id', 'recommendation_id', 'response'],
    },
    async run(ctx, args) {
      const gid = intArg(args, 'group_id');
      const sid = intArg(args, 'recommendation_id');
      const d = await ok(ctx, suggestionApi.onRequestPost, {
        method: 'POST', path: `/api/groups/${gid}/suggestions/${sid}`, params: { id: String(gid), sid: String(sid) },
        body: { response: args.response },
      }, 'That recommendation');
      return { recommendation: d.suggestion, ...(d.show ? { show: compactShow(d.show) } : {}) };
    },
  },
  {
    name: 'remove_recommendation',
    title: 'Remove a group recommendation',
    description: "Take a card off a group's Watch Next board for everyone. Only its recommender or the group's creator can.",
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: { group_id: { type: 'integer' }, recommendation_id: { type: 'integer' } },
      required: ['group_id', 'recommendation_id'],
    },
    async run(ctx, args) {
      const gid = intArg(args, 'group_id');
      const sid = intArg(args, 'recommendation_id');
      await ok(ctx, suggestionApi.onRequestDelete, {
        method: 'DELETE', path: `/api/groups/${gid}/suggestions/${sid}`, params: { id: String(gid), sid: String(sid) },
      }, 'That recommendation');
      return { removed: sid };
    },
  },
  {
    name: 'create_group',
    title: 'Create a group',
    description: 'Create a new private group with you in it, and get an invite link to share. People join only by opening the link themselves.',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    async run(ctx, args) {
      const d = await ok(ctx, groupsApi.onRequestPost, { method: 'POST', path: '/api/groups', body: { name: strArg(args, 'name', { required: true, max: 60 }) } });
      return { group: { id: d.group.id, name: d.group.name }, invite: d.invite };
    },
  },
  {
    name: 'create_group_invite',
    title: 'Invite to a group',
    description: 'Creates a new invite link for one of your groups, good for 10 people over 7 days. Anyone who opens it can join.',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: { type: 'object', properties: { group_id: { type: 'integer' } }, required: ['group_id'] },
    async run(ctx, args) {
      const gid = intArg(args, 'group_id');
      const invite = await ok(ctx, groupInviteApi.onRequestPost, { method: 'POST', path: `/api/groups/${gid}/invite`, params: { id: String(gid) } }, 'That group');
      return { invite };
    },
  },
  {
    name: 'leave_group',
    title: 'Leave a group',
    description: 'Leaves one of your groups. Your recommendations and invite links in it are removed, and its members lose access to your lists through it.',
    scope: 'shows:write',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: { type: 'object', properties: { group_id: { type: 'integer' } }, required: ['group_id'] },
    async run(ctx, args) {
      const gid = intArg(args, 'group_id');
      await ok(ctx, groupLeaveApi.onRequestPost, { method: 'POST', path: `/api/groups/${gid}/leave`, params: { id: String(gid) } }, 'That group');
      return { left: gid };
    },
  },
];

const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

export function toolNamed(name) {
  return TOOLS_BY_NAME[name] || null;
}

export function toolsFor(scopes) {
  return TOOLS.filter((t) => scopes.includes(t.scope)).map(({ name, title, description, inputSchema, annotations }) => ({
    name, title, description, inputSchema: { ...inputSchema, additionalProperties: false }, annotations,
  }));
}
