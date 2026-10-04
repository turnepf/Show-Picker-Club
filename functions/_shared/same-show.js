// "Is this the same show?" — one rule, everywhere.
//
// A TMDB entry is a show's identity. Two rows are the same show when both are
// pinned to the same entry; a title only decides when one side was never
// pinned. So the three 2026 films called "The Odyssey" are three shows, and a
// row pinned to one of them is never "your copy" of another.
//
// The SQL forms take a table alias ('s', 'x', …) and read the same columns
// from `shows`, `shows_v` or `group_suggestions` rows: title, tmdb_id,
// movie and (where present) tmdb_type.

// Pass hasType: false for a table with no tmdb_type column
// (group_suggestions), whose type is its movie flag.
const typeSql = (a, hasType = true) => hasType
  ? `COALESCE(${a}.tmdb_type, CASE WHEN ${a}.movie = 1 THEN 'movie' ELSE 'tv' END)`
  : `CASE WHEN ${a}.movie = 1 THEN 'movie' ELSE 'tv' END`;

// The type of an incoming show described in JS: an explicit tmdb_type wins,
// then movie-ness, else unknown (null).
export function showType(show) {
  const t = show?.tmdb_type ?? show?.tmdbType;
  if (t === 'movie' || t === 'tv') return t;
  if (show?.movie === undefined || show?.movie === null) return null;
  return show.movie ? 'movie' : 'tv';
}

function showId(show) {
  const n = parseInt(show?.tmdb_id ?? show?.tmdbId, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// WHERE fragment matching rows (alias `a`) that are copies of `show`.
// A pinned show matches rows pinned to the same entry, plus unpinned rows
// carrying its title. An unpinned show matches by title alone.
//
// forWrite: true is for a write fanning out from an unpinned show — a guess
// made from its title — which must stop at copies that are pinned, since
// those already know which show they are.
export function sameShowWhere(a, show, { hasType = true, forWrite = false } = {}) {
  const id = showId(show);
  const title = String(show?.title || '');
  if (!id) {
    const sql = `LOWER(${a}.title) = LOWER(?)`;
    return { sql: forWrite ? `(${a}.tmdb_id IS NULL AND ${sql})` : sql, binds: [title] };
  }
  const type = showType(show);
  const idSql = type ? `(${a}.tmdb_id = ? AND ${typeSql(a, hasType)} = ?)` : `${a}.tmdb_id = ?`;
  return {
    sql: `(${idSql} OR (${a}.tmdb_id IS NULL AND LOWER(${a}.title) = LOWER(?)))`,
    binds: type ? [id, type, title] : [id, title],
  };
}

// Join predicate: rows `a` and `b` are the same show.
export function sameShowJoin(a, b) {
  return `((${a}.tmdb_id IS NOT NULL AND ${b}.tmdb_id IS NOT NULL
      AND ${a}.tmdb_id = ${b}.tmdb_id AND ${typeSql(a)} = ${typeSql(b)})
    OR ((${a}.tmdb_id IS NULL OR ${b}.tmdb_id IS NULL) AND LOWER(${a}.title) = LOWER(${b}.title)))`;
}

// Grouping key: one value per show across members.
export function showKeySql(a) {
  return `CASE WHEN ${a}.tmdb_id IS NOT NULL THEN ${typeSql(a)} || ':' || ${a}.tmdb_id
    ELSE 'title:' || LOWER(TRIM(${a}.title)) END`;
}

// The same rule in JS, for rows already in memory.
export function sameShow(x, y) {
  const xi = showId(x), yi = showId(y);
  if (xi && yi) {
    const xt = showType(x), yt = showType(y);
    return xi === yi && (!xt || !yt || xt === yt);
  }
  return String(x?.title || '').toLowerCase() === String(y?.title || '').toLowerCase();
}

export function showKey(show) {
  const id = showId(show);
  if (id) return `${showType(show) || 'tv'}:${id}`;
  return 'title:' + String(show?.title || '').trim().toLowerCase();
}

// WHERE fragment matching the copies (alias `a`) that a key from showKey()
// or showKeySql() names: the entry's copies, or the unpinned copies of a title.
export function keyWhere(a, key) {
  const m = /^(tv|movie):(\d+)$/.exec(String(key || ''));
  if (m) {
    return {
      sql: `(${a}.tmdb_id = ? AND ${typeSql(a)} = ?)`,
      binds: [Number(m[2]), m[1]],
    };
  }
  return {
    sql: `(${a}.tmdb_id IS NULL AND LOWER(TRIM(${a}.title)) = ?)`,
    binds: [String(key || '').replace(/^title:/, '')],
  };
}
