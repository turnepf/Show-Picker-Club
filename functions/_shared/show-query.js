// Club-wide questions about shows, answered in one query: "how many unique
// shows are there", "how many are from 2020 or later", "which TV shows have
// no genres", "average rating by network". The engine behind
// POST /api/admin-query and the admin_query MCP tool.
//
// A spec, not SQL. The caller names fields from FIELDS below, and every field
// maps to an SQL expression written here; values are always bound, never
// spliced. That is what keeps an admin's AI connection from becoming a read of
// the whole database: sessions, OAuth tokens, login emails and phone numbers
// live in the same D1, and no field reaches them. Private memos (notes,
// watching-with, recommended-by) are presence-only, so a query can count shows
// that have a note but never read one, the same line admin_list_member_shows
// draws. added_by (a login email) isn't a field at all, and neither is a
// private group: a group's membership is legible to admins, its content never
// is (docs/INVARIANTS.md §13), and "shows per group" is its content.
//
// Two shapes:
//   mode 'aggregate' (default): measures, optionally grouped by up to two
//     fields, plus club-wide totals for the same filters.
//   mode 'rows': the matching shows themselves, one row per show, paged.
//
// Every aggregate runs over one row per (group key, show), so a show with
// three genres counts once in each genre and once in the totals, and an
// average isn't skewed by the join that produced the keys.

import { demoMemberSlug } from './demo.js';

export class QueryError extends Error {}

const LIST_TO_DB = { watching: 'watching', awaiting: 'waiting', loved: 'recommending', next_up: 'next' };
const LIST_SQL = `CASE s.list WHEN 'waiting' THEN 'awaiting' WHEN 'recommending' THEN 'loved'
  WHEN 'next' THEN 'next_up' ELSE s.list END`;
const TYPE_SQL = `CASE WHEN s.movie = 1 THEN 'movie' ELSE 'tv' END`;
const TMDB_TYPE_SQL = `COALESCE(s.tmdb_type, ${TYPE_SQL})`;

// One show across members: the same TMDB entry, or the same title for a row
// TMDB never matched. So the 1974 and 2026 Little House are two shows, and
// "Little House on the Prairie (2026)" on one list and the bare title on
// another are one, as long as both are pinned to the same entry.
const TITLE_KEY_SQL = `CASE WHEN s.tmdb_id IS NOT NULL THEN ${TMDB_TYPE_SQL} || ':' || s.tmdb_id
  ELSE 'title:' || LOWER(TRIM(s.title)) END`;

// A comma-separated column ("Drama, Western, Family") as a json array that
// json_each can expand, one row per entry. '[null]' for an empty column, so a
// show with no genres still yields one row and groups under null instead of
// vanishing from a breakdown.
function splitList(col) {
  return `json_each(CASE WHEN TRIM(COALESCE(${col}, '')) = '' THEN '[null]'
    ELSE '["' || REPLACE(REPLACE(REPLACE(TRIM(${col}), '\\', ''), '"', ''), ', ', '","') || '"]' END)`;
}

// Whole-entry match in a comma-separated column, case-insensitive. instr, not
// LIKE, so a % or _ in the value is text.
function listHas(col) {
  return `instr(', ' || LOWER(COALESCE(${col}, '')) || ', ', ', ' || LOWER(?) || ', ') > 0`;
}

// type: text | number | bool | date | presence | multi
//   presence: only empty / not_empty, never a column or a group (private memos).
//   multi: several values per show. Filterable, groupable (one per query),
//     never a column; the comma-joined source field is the column instead.
// group / measure / column: what else the field may be used for.
const FIELDS = {
  show_id: { type: 'number', sql: 's.id', column: true, help: 'the row id' },
  title: { type: 'text', sql: 's.title', group: true, column: true },
  member: { type: 'text', sql: 's.member_slug', group: true, column: true, help: 'member slug' },
  member_name: { type: 'text', sql: 'm.name', group: true, column: true },
  list: { type: 'text', sql: LIST_SQL, group: true, column: true, help: 'watching | awaiting | loved | next_up' },
  archived: { type: 'bool', sql: 'COALESCE(s.archived, 0)', group: true, column: true },
  type: { type: 'text', sql: TYPE_SQL, group: true, column: true, help: 'tv | movie' },
  network: { type: 'text', sql: 's.network', group: true, column: true, help: "the member's service" },
  release_year: { type: 'number', sql: 's.release_year', group: true, measure: true, column: true },
  decade: { type: 'number', sql: '((s.release_year / 10) * 10)', group: true, help: '1990, 2000, …' },
  runtime: { type: 'number', sql: 's.runtime', measure: true, column: true, help: 'minutes (per episode for TV)' },
  seasons_released: { type: 'number', sql: 's.seasons_released', group: true, measure: true, column: true },
  episodes_released: { type: 'number', sql: 's.episodes_released', measure: true, column: true },
  club_rating: { type: 'number', sql: `CAST(NULLIF(TRIM(s.rating), '') AS REAL)`, measure: true, column: true, help: "TMDB's audience score, 0–10" },
  vote_count: { type: 'number', sql: 's.vote_count', measure: true, column: true, help: 'votes behind club_rating' },
  member_rating: { type: 'number', sql: 'sr.rating', group: true, measure: true, column: true, help: "the owner's own 1–10 rating" },
  content_rating: { type: 'text', sql: 's.content_rating', group: true, column: true },
  original_language: { type: 'text', sql: 's.original_language', group: true, column: true },
  studio: { type: 'text', sql: 's.studio', group: true, column: true },
  director: { type: 'text', sql: 's.director', group: true, column: true, help: 'director (movie) or creators (TV)' },
  tmdb_status: { type: 'text', sql: 's.tmdb_status', group: true, column: true, help: 'Returning Series, Ended, …' },
  full_series: { type: 'bool', sql: 'COALESCE(s.full_series, 0)', group: true, column: true, help: 'the series has ended' },
  tmdb_id: { type: 'number', sql: 's.tmdb_id', column: true },
  imdb_id: { type: 'text', sql: 's.imdb_id', column: true },
  genres: { type: 'text', sql: 's.genres', column: true, help: 'comma-joined; use genre to match or group one' },
  genre: { type: 'multi', multi: 'genre', help: 'one genre, e.g. Drama' },
  streaming_on: { type: 'text', sql: 's.streaming_on', column: true, help: 'comma-joined services TMDB lists' },
  streaming_service: { type: 'multi', multi: 'streaming_service', help: 'one service from streaming_on' },
  free_on: { type: 'text', sql: 's.free_on', column: true, help: 'comma-joined free / with-ads services' },
  actor: { type: 'multi', multi: 'actor', help: 'a cast member by name' },
  watch_url: { type: 'text', sql: 's.network_url', column: true },
  poster_url: { type: 'text', sql: 's.poster_url', column: true },
  next_episode_date: { type: 'date', sql: 's.next_season_date', column: true },
  added_at: { type: 'date', sql: 's.created_at', column: true, help: 'NULL on seeded rows' },
  added_year: { type: 'text', sql: 'substr(s.created_at, 1, 4)', group: true },
  added_month: { type: 'text', sql: 'substr(s.created_at, 1, 7)', group: true },
  updated_at: { type: 'date', sql: 's.updated_at', column: true },
  enriched_at: { type: 'date', sql: 's.enriched_at', column: true, help: 'last background TMDB refresh' },
  notes: { type: 'presence', sql: 's.notes', help: 'private memo — empty / not_empty only' },
  watching_with: { type: 'presence', sql: 's.watching_with', help: 'private memo — empty / not_empty only' },
  recommended_by: { type: 'presence', sql: 's.recommended_by', help: 'private memo — empty / not_empty only' },
};

// How each multi field joins in when it's a group key (one row per value).
const MULTI_JOIN = {
  genre: { join: `LEFT JOIN ${splitList('s.genres')} mv`, key: `NULLIF(TRIM(mv.value), '')` },
  streaming_service: { join: `LEFT JOIN ${splitList('s.streaming_on')} mv`, key: `NULLIF(TRIM(mv.value), '')` },
  actor: { join: 'LEFT JOIN actors_v mv ON mv.show_id = s.id', key: 'mv.name' },
};

const OPS = {
  text: ['eq', 'ne', 'in', 'not_in', 'contains', 'starts_with', 'empty', 'not_empty'],
  number: ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'],
  bool: ['eq'],
  date: ['gt', 'gte', 'lt', 'lte', 'between', 'empty', 'not_empty'],
  presence: ['empty', 'not_empty'],
  multi: ['eq', 'ne', 'in', 'contains', 'empty', 'not_empty'],
};

const MEASURE_FNS = ['avg', 'sum', 'min', 'max'];
const DEFAULT_COLUMNS = ['show_id', 'title', 'member', 'list', 'archived', 'type', 'release_year', 'network', 'genres', 'seasons_released', 'member_rating'];
const MAX_FILTERS = 20;
const MAX_IN = 100;
export const MAX_GROUPS = 500;
export const MAX_ROWS = 500;

const BASE_FROM = `FROM shows_v s
  JOIN members m ON m.slug = s.member_slug
  LEFT JOIN show_ratings sr ON sr.tmdb_id = s.tmdb_id AND sr.member_slug = s.member_slug
    AND sr.season_number = 0 AND sr.tmdb_type = ${TMDB_TYPE_SQL}`;

function field(name, use) {
  const f = typeof name === 'string' && Object.prototype.hasOwnProperty.call(FIELDS, name) ? FIELDS[name] : null;
  if (!f) throw new QueryError(`Unknown field "${name}". Fields: ${Object.keys(FIELDS).join(', ')}.`);
  if (use === 'group' && !f.group && f.type !== 'multi') throw new QueryError(`"${name}" can't be a group_by field.`);
  if (use === 'column' && !f.column) {
    throw new QueryError(f.type === 'presence'
      ? `"${name}" is a private memo: it can be filtered with empty / not_empty, never returned.`
      : `"${name}" can't be a column${f.type === 'multi' ? ' (use the comma-joined field, e.g. genres, instead)' : ''}.`);
  }
  if (use === 'measure' && !f.measure) throw new QueryError(`"${name}" isn't numeric; avg/sum/min/max take one of: ${Object.keys(FIELDS).filter((k) => FIELDS[k].measure).join(', ')}.`);
  return f;
}

function scalar(v, type, name) {
  if (type === 'number') {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new QueryError(`${name} needs a number, got ${JSON.stringify(v)}.`);
    return n;
  }
  if (type === 'date') {
    const s = String(v ?? '').trim();
    if (!/^\d{4}(-\d{2}(-\d{2}([ T][\d:.]+Z?)?)?)?$/.test(s)) throw new QueryError(`${name} needs a date like 2026-10-04, got ${JSON.stringify(v)}.`);
    // A bare year or month means its first day.
    return s.length === 4 ? `${s}-01-01` : s.length === 7 ? `${s}-01` : s;
  }
  if (v === null || v === undefined || typeof v === 'object') throw new QueryError(`${name} needs a value.`);
  return String(v);
}

// The list field speaks the member vocabulary; the column stores the old
// names. Mapping the value (rather than comparing against LIST_SQL) keeps the
// comparison on the raw column.
function listValue(v) {
  const k = String(v).trim().toLowerCase();
  if (!LIST_TO_DB[k]) throw new QueryError(`list is one of watching, awaiting, loved, next_up (got ${JSON.stringify(v)}).`);
  return LIST_TO_DB[k];
}

function multiCondition(f, op, value, binds) {
  const empty = {
    genre: `TRIM(COALESCE(s.genres, '')) = ''`,
    streaming_service: `TRIM(COALESCE(s.streaming_on, '')) = ''`,
    actor: 'NOT EXISTS (SELECT 1 FROM actors_v fa WHERE fa.show_id = s.id)',
  }[f.multi];
  if (op === 'empty') return empty;
  if (op === 'not_empty') return `NOT (${empty})`;
  const one = (v, exact) => {
    const s = scalar(v, 'text', f.multi);
    switch (f.multi) {
      case 'genre':
      case 'streaming_service': {
        const col = f.multi === 'genre' ? 's.genres' : 's.streaming_on';
        binds.push(s);
        return exact ? listHas(col) : `instr(LOWER(COALESCE(${col}, '')), LOWER(?)) > 0`;
      }
      case 'actor':
        binds.push(s);
        return `EXISTS (SELECT 1 FROM actors_v fa WHERE fa.show_id = s.id AND ${exact ? 'LOWER(fa.name) = LOWER(?)' : 'instr(LOWER(fa.name), LOWER(?)) > 0'})`;
    }
    throw new QueryError('unreachable');
  };
  if (op === 'eq') return one(value, true);
  if (op === 'ne') return `NOT (${one(value, true)})`;
  if (op === 'contains') return one(value, false);
  // in
  return `(${inValues(value, f.multi).map((v) => one(v, true)).join(' OR ')})`;
}

function inValues(value, name) {
  if (!Array.isArray(value) || !value.length) throw new QueryError(`"in" on ${name} needs a non-empty array.`);
  if (value.length > MAX_IN) throw new QueryError(`"in" takes at most ${MAX_IN} values.`);
  return value;
}

function condition(filter, binds) {
  if (!filter || typeof filter !== 'object') throw new QueryError('Each filter is { field, op, value }.');
  const name = filter.field;
  const f = field(name, 'filter');
  const op = filter.op ?? 'eq';
  if (!OPS[f.type].includes(op)) throw new QueryError(`${name} takes ops: ${OPS[f.type].join(', ')} (got ${JSON.stringify(op)}).`);
  if (f.type === 'multi') return multiCondition(f, op, filter.value, binds);

  const col = f.sql;
  const isEmpty = f.type === 'number' ? `${col} IS NULL` : `TRIM(COALESCE(${col}, '')) = ''`;
  if (op === 'empty') return isEmpty;
  if (op === 'not_empty') return `NOT (${isEmpty})`;

  if (f.type === 'bool') {
    const v = filter.value;
    const b = v === true || v === 1 || v === 'true' || v === '1' ? 1
      : v === false || v === 0 || v === 'false' || v === '0' ? 0 : null;
    if (b === null) throw new QueryError(`${name} takes true or false.`);
    binds.push(b);
    return `${col} = ?`;
  }

  if (f.type === 'date') {
    // julianday() reads both stored shapes — datetime('now')'s
    // "2026-10-04 13:29:09" and an ISO "2026-10-04T13:29:09Z" — which a plain
    // string comparison doesn't (the space sorts before the T).
    if (op === 'between') {
      const [a, b] = rangeOf(filter.value, name);
      binds.push(scalar(a, 'date', name), scalar(b, 'date', name));
      return `(julianday(${col}) >= julianday(?) AND julianday(${col}) <= julianday(?))`;
    }
    binds.push(scalar(filter.value, 'date', name));
    return `julianday(${col}) ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]} julianday(?)`;
  }

  const isList = name === 'list';
  const val = (v) => (isList ? listValue(v) : scalar(v, f.type, name));
  // list compares on the raw column; text compares case-insensitively.
  const lhs = isList ? 's.list' : f.type === 'text' ? `LOWER(${col})` : col;
  const rhs = isList || f.type !== 'text' ? '?' : 'LOWER(?)';

  switch (op) {
    case 'eq': binds.push(val(filter.value)); return `${lhs} = ${rhs}`;
    // ne keeps rows where the field is empty: "network isn't Netflix" includes
    // shows with no network.
    case 'ne': binds.push(val(filter.value)); return `(${lhs} IS NULL OR ${lhs} <> ${rhs})`;
    case 'in':
    case 'not_in': {
      const vals = inValues(filter.value, name).map(val);
      binds.push(...vals);
      const set = `(${vals.map(() => rhs).join(', ')})`;
      return op === 'in' ? `${lhs} IN ${set}` : `(${lhs} IS NULL OR ${lhs} NOT IN ${set})`;
    }
    case 'contains': binds.push(val(filter.value)); return `instr(LOWER(COALESCE(${col}, '')), LOWER(?)) > 0`;
    case 'starts_with': binds.push(val(filter.value)); return `instr(LOWER(COALESCE(${col}, '')), LOWER(?)) = 1`;
    case 'between': {
      const [a, b] = rangeOf(filter.value, name);
      binds.push(val(a), val(b));
      return `(${col} >= ? AND ${col} <= ?)`;
    }
    default:
      binds.push(val(filter.value));
      return `${col} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]} ?`;
  }
}

function rangeOf(value, name) {
  if (!Array.isArray(value) || value.length !== 2) throw new QueryError(`"between" on ${name} needs [low, high].`);
  return value;
}

// "rows" | "titles" | "members" | "avg:field" | …, as { label, outer SQL }.
function measureOf(spec) {
  const s = String(spec ?? '').trim();
  if (s === 'rows') return { label: 'rows', sql: 'COUNT(DISTINCT q.sid)' };
  if (s === 'titles') return { label: 'titles', sql: 'COUNT(DISTINCT q.tk)' };
  if (s === 'members') return { label: 'members', sql: 'COUNT(DISTINCT q.ms)' };
  const m = s.match(/^(avg|sum|min|max):([a-z_]+)$/);
  if (!m) throw new QueryError(`Unknown measure "${s}". Use rows, titles, members, or ${MEASURE_FNS.map((f) => `${f}:<field>`).join(', ')}.`);
  const f = field(m[2], 'measure');
  return { label: s, fn: m[1], field: m[2], fieldSql: f.sql };
}

function boundedInt(v, dflt, max, name) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new QueryError(`${name} must be a whole number.`);
  return Math.min(n, max);
}

// Validate and normalize. Everything after this works off the result, and the
// result is echoed back so the caller can see how its question was read.
export function normalizeSpec(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new QueryError('The query is a JSON object.');
  const mode = raw.mode ?? 'aggregate';
  if (mode !== 'aggregate' && mode !== 'rows') throw new QueryError('mode is "aggregate" or "rows".');
  const filters = raw.filters ?? [];
  if (!Array.isArray(filters)) throw new QueryError('filters is an array of { field, op, value }.');
  if (filters.length > MAX_FILTERS) throw new QueryError(`At most ${MAX_FILTERS} filters.`);
  const out = {
    mode,
    filters: filters.map((f) => ({ field: f && f.field, op: (f && f.op) ?? 'eq', ...(f && 'value' in f ? { value: f.value } : {}) })),
    include_demo: raw.include_demo === true,
  };
  if (mode === 'aggregate') {
    const measures = raw.measures ?? ['rows', 'titles'];
    if (!Array.isArray(measures) || !measures.length || measures.length > 6) throw new QueryError('measures is an array of 1–6 entries.');
    measures.forEach(measureOf);
    const groupBy = raw.group_by ?? [];
    if (!Array.isArray(groupBy) || groupBy.length > 2) throw new QueryError('group_by is an array of at most 2 fields.');
    const fs = groupBy.map((g) => field(g, 'group'));
    if (fs.filter((f) => f.type === 'multi').length > 1) throw new QueryError('Only one of genre, streaming_service and actor can be grouped on at a time.');
    if (new Set(groupBy).size !== groupBy.length) throw new QueryError('group_by repeats a field.');
    const sort = raw.sort ?? 'desc';
    if (!['desc', 'asc', 'key'].includes(sort)) throw new QueryError('sort is "desc", "asc" (by the first measure) or "key".');
    Object.assign(out, {
      measures: measures.map(String),
      group_by: groupBy,
      sort,
      limit: boundedInt(raw.limit, 50, MAX_GROUPS, 'limit'),
    });
  } else {
    const columns = raw.columns ?? DEFAULT_COLUMNS;
    if (!Array.isArray(columns) || !columns.length || columns.length > 30) throw new QueryError('columns is an array of 1–30 fields.');
    columns.forEach((c) => field(c, 'column'));
    const sortBy = raw.sort_by ?? 'title';
    field(sortBy, 'column');
    const sort = raw.sort ?? 'asc';
    if (!['asc', 'desc'].includes(sort)) throw new QueryError('sort is "asc" or "desc" in rows mode.');
    Object.assign(out, {
      columns: [...new Set(columns)],
      sort_by: sortBy,
      sort,
      limit: boundedInt(raw.limit, 100, MAX_ROWS, 'limit'),
      offset: boundedInt(raw.offset, 0, 1e9, 'offset'),
    });
  }
  // Validates every filter (field, op, value) before any SQL runs.
  out.filters.forEach((f) => condition(f, []));
  return out;
}

async function whereClause(env, spec) {
  const binds = [];
  const parts = ['COALESCE(m.disabled, 0) = 0'];
  if (!spec.include_demo) {
    const demo = await demoMemberSlug(env);
    if (demo) { parts.push('s.member_slug <> ?'); binds.push(demo); }
  }
  for (const f of spec.filters) parts.push(condition(f, binds));
  return { sql: parts.join('\n    AND '), binds };
}

function measureSql(m) {
  if (m.sql) return m.sql;
  const fn = m.fn.toUpperCase();
  return m.fn === 'avg' ? `ROUND(AVG(q.mv_${m.field}), 2)` : `${fn}(q.mv_${m.field})`;
}

export async function runShowQuery(env, rawSpec) {
  const spec = normalizeSpec(rawSpec);
  const where = await whereClause(env, spec);

  if (spec.mode === 'rows') {
    const cols = spec.columns.map((c) => `${FIELDS[c].sql} AS ${c}`).join(', ');
    const sortSql = FIELDS[spec.sort_by].sql;
    const order = `${sortSql} IS NULL, ${sortSql} ${spec.sort === 'desc' ? 'DESC' : 'ASC'}, s.id`;
    const { results } = await env.DB.prepare(
      `SELECT ${cols} ${BASE_FROM} WHERE ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`
    ).bind(...where.binds, spec.limit, spec.offset).all();
    const total = await env.DB.prepare(`SELECT COUNT(*) AS n ${BASE_FROM} WHERE ${where.sql}`)
      .bind(...where.binds).first();
    const rows = (results || []).map((r) => {
      if ('archived' in r) r.archived = !!r.archived;
      if ('full_series' in r) r.full_series = !!r.full_series;
      return r;
    });
    return { query: spec, total: total ? total.n : 0, returned: rows.length, rows };
  }

  const measures = spec.measures.map(measureOf);
  const valueCols = [...new Set(measures.filter((m) => m.field).map((m) => m.field))];
  const multi = spec.group_by.map((g) => FIELDS[g]).find((f) => f.type === 'multi');
  const keys = spec.group_by.map((g, i) => ({
    name: g,
    sql: FIELDS[g].type === 'multi' ? MULTI_JOIN[FIELDS[g].multi].key : FIELDS[g].sql,
    alias: `k${i}`,
  }));

  // Inner: one row per (keys, show). Outer: the measures over it.
  const inner = (withKeys) => `SELECT DISTINCT ${[
    ...(withKeys ? keys.map((k) => `${k.sql} AS ${k.alias}`) : []),
    's.id AS sid', `${TITLE_KEY_SQL} AS tk`, 's.member_slug AS ms',
    ...valueCols.map((c) => `${FIELDS[c].sql} AS mv_${c}`),
  ].join(', ')}
    ${BASE_FROM}
    ${withKeys && multi ? MULTI_JOIN[multi.multi].join : ''}
    WHERE ${where.sql}`;
  const measureCols = measures.map((m, i) => `${measureSql(m)} AS m${i}`).join(', ');

  const totalsRow = await env.DB.prepare(`SELECT ${measureCols} FROM (${inner(false)}) q`)
    .bind(...where.binds).first();
  const shape = (r) => Object.fromEntries(measures.map((m, i) => [m.label, r ? r[`m${i}`] ?? null : null]));
  const totals = shape(totalsRow);

  if (!keys.length) return { query: spec, totals };

  const keyCols = keys.map((k) => `q.${k.alias}`).join(', ');
  const order = spec.sort === 'key'
    ? keys.map((k) => `q.${k.alias} IS NULL, q.${k.alias}`).join(', ')
    : `m0 ${spec.sort === 'asc' ? 'ASC' : 'DESC'}, ${keys.map((k) => `q.${k.alias}`).join(', ')}`;
  const grouped = `SELECT ${keyCols}, ${measureCols} FROM (${inner(true)}) q GROUP BY ${keyCols}`;
  const { results } = await env.DB.prepare(`${grouped} ORDER BY ${order} LIMIT ?`)
    .bind(...where.binds, spec.limit).all();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM (${grouped})`).bind(...where.binds).first();
  const groups = (results || []).map((r) => ({
    ...Object.fromEntries(keys.map((k) => [k.name, normalizeKey(k.name, r[k.alias])])),
    ...shape(r),
  }));
  const totalGroups = count ? count.n : groups.length;
  return { query: spec, totals, total_groups: totalGroups, truncated: totalGroups > groups.length, groups };
}

function normalizeKey(name, v) {
  if ((name === 'archived' || name === 'full_series') && v !== null) return !!v;
  return v ?? null;
}

// The field reference, for the tool description and 400 messages: one line
// per field, so a model can pick fields without guessing.
export function fieldGuide() {
  return Object.entries(FIELDS).map(([name, f]) => {
    const uses = [f.group || f.type === 'multi' ? 'group' : null, f.measure ? 'measure' : null, f.column ? 'column' : null].filter(Boolean);
    return `${name} (${f.type}${uses.length ? `; ${uses.join(', ')}` : ''})${f.help ? ` — ${f.help}` : ''}`;
  }).join('\n');
}

export const QUERY_FIELDS = Object.keys(FIELDS);
export const GROUP_FIELDS = Object.keys(FIELDS).filter((k) => FIELDS[k].group || FIELDS[k].type === 'multi');
export const COLUMN_FIELDS = Object.keys(FIELDS).filter((k) => FIELDS[k].column);
export const QUERY_OPS = [...new Set(Object.values(OPS).flat())];
