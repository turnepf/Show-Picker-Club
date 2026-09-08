// The movie enrichment pass has to select on the whole detail block it writes,
// not just on artwork — the gap that left 91% of the movie library with no
// genres (2026-09).
//
//   node scripts/enrich-movie-detail-test.mjs
//
// The movie pass in /api/enrich writes eighteen fields: genres, overview,
// runtime, tagline, studio, director, trailer, content rating and the rest.
// Its selection, though, was `poster_url IS NULL OR network IS NULL` — artwork
// only. A film inserts WITH a poster and a network (synchronous insert
// enrichment sets both, and no path there writes genres), so it never
// qualified for the pass again and never received the other sixteen fields.
//
// Unlike the TV pass — which has no gap predicate at all in its normal mode
// and so cycles the whole library by oldest enriched_at — nothing else could
// reach a movie. Production carried 125 of 137 unarchived films with no genre,
// no overview and no runtime, every one of them invisible to BOTH repair
// paths: they had posters and networks (so the normal pass skipped them) and
// they had cast (so `mode: 'gaps'`, which keyed on missing cast, skipped them
// too). The member-visible symptom: filtering Next Up by genre hid every
// movie, because a movie matched no genre at all.
//
// Pinned here:
//   1. A movie with poster + network but no genres IS selected, and comes back
//      with the whole detail block. This is the property that was missing.
//   2. A movie already complete is NOT re-fetched — the widened gate must not
//      turn into an unbounded rotation that re-reads the library every call.
//   3. `mode: 'gaps'` selects it too, and `remaining.movies` counts it, so the
//      operator tool can be driven to zero instead of reporting nothing to do.
//   4. `mode: 'posters'` keeps its narrow artwork gate — that batch is a small
//      artwork top-up (max_tmdb 6), not a detail fill.
//   5. The loop stops on the subrequest budget instead of running unbounded.
//      It had no budget check at all, which was safe only while its selection
//      was nearly always empty.
//
// Same harness as scripts/enrich-identity-test.mjs: functions copied to a temp
// dir as ES modules, schema.sql in node:sqlite behind a D1 shim, TMDB faked.

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'enrich-movie-detail-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const enrichApi = await import(join(sandbox, 'functions', 'api/enrich.js'));

const ORIGIN = 'https://showpicker.club';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

// ---- D1 shim over node:sqlite ----

class Stmt {
  constructor(db, sql, args = []) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : a))); }
  async first() {
    const rows = this.db.prepare(this.sql).all(...this.args);
    return rows.length ? { ...rows[0] } : null;
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { changes: Number(r.changes ?? 0), last_row_id: Number(r.lastInsertRowid ?? 0) } };
  }
}

// ---- fake TMDB ----
//
// Every film here is fully populated, so anything missing from a row after a
// pass means the row was never selected — not that TMDB had nothing to give.

const FILMS = {
  501: { title: 'Sinners', year: '2025-04-18', genre: 'Horror', runtime: 137 },
  502: { title: 'Conclave', year: '2024-10-25', genre: 'Drama', runtime: 120 },
  503: { title: 'Hundreds of Beavers', year: '2024-02-16', genre: 'Comedy', runtime: 108 },
  504: { title: 'Flow', year: '2024-11-22', genre: 'Animation', runtime: 85 },
  505: { title: 'Nickel Boys', year: '2024-12-13', genre: 'Drama', runtime: 140 },
  // Rent/buy only — no flatrate provider, so no logo exists to fetch. This is
  // the film a standing `network_logo_url IS NULL` gate would churn on forever.
  506: { title: 'Anora', year: '2024-10-18', genre: 'Drama', runtime: 139, provider: null },
};

const movieDetail = (id) => {
  const f = FILMS[id];
  return {
    id: Number(id), title: f.title, release_date: f.year,
    poster_path: `/${id}.jpg`, backdrop_path: `/${id}-b.jpg`,
    overview: `${f.title} — the overview.`, tagline: `${f.title} tagline.`,
    vote_average: 7.7, vote_count: 900, runtime: f.runtime, original_language: 'en',
    genres: [{ name: f.genre }],
    production_companies: [{ name: 'A24' }],
    credits: { cast: [{ id: 900 + Number(id), name: `${f.title} Lead`, order: 0 }],
               crew: [{ job: 'Director', id: 800 + Number(id), name: `${f.title} Director` }] },
    videos: { results: [] }, release_dates: { results: [] },
    // A flatrate provider, the way TMDB answers for a film that streams: the
    // provider object carries the logo. Movies have no `networks[]`, so this
    // is the only place a film's service badge can come from.
    'watch/providers': { results: { US: { link: 'https://tmdb/watch',
      flatrate: f.provider === null ? [] : [{ provider_name: 'Max', logo_path: '/max-logo.jpg', display_priority: 1 }],
      rent: f.provider === null ? [{ provider_name: 'Apple TV' }] : [] } } },
  };
};

const jsonRes = (data, status = 200) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, json: async () => data,
});

let fetchLog = [];
globalThis.fetch = async (url) => {
  url = String(url);
  fetchLog.push(url);
  const u = new URL(url);
  if (u.pathname === '/3/search/movie') {
    const q = (u.searchParams.get('query') || '').toLowerCase();
    const hit = Object.keys(FILMS).find((id) => FILMS[id].title.toLowerCase() === q);
    return jsonRes({ results: hit ? [{ id: Number(hit), title: FILMS[hit].title, release_date: FILMS[hit].year, poster_path: `/${hit}.jpg` }] : [] });
  }
  const movie = u.pathname.match(/^\/3\/movie\/(\d+)$/);
  if (movie) return FILMS[movie[1]] ? jsonRes(movieDetail(movie[1])) : jsonRes({ success: false }, 404);
  const person = u.pathname.match(/^\/3\/person\/(\d+)\/external_ids$/);
  if (person) return jsonRes({ imdb_id: `nm${person[1].padStart(7, '0')}` });
  if (u.pathname.startsWith('/3/tv/') || u.pathname === '/3/search/tv') return jsonRes({ results: [] });
  throw new Error(`unexpected fetch: ${url}`);
};

// ---- fixtures ----

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(repoRoot, 'schema.sql'), 'utf8'));
  db.prepare('INSERT INTO members (slug, name, first_name) VALUES (?, ?, ?)').run('patrick', 'Patrick Turner', 'Patrick');
  db.prepare('INSERT INTO member_emails (email, member_slug, is_primary) VALUES (?, ?, 1)').run('patrick@example.com', 'patrick');
  db.prepare('INSERT INTO sessions (id, email, member_slug, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('sess', 'patrick@example.com', 'patrick', new Date(Date.now() + 86400000).toISOString(), new Date().toISOString());
  return {
    TMDB_TOKEN: 'test-token',
    DB: { prepare: (sql) => new Stmt(db, sql), batch: async (stmts) => { for (const s of stmts) await s.run(); } },
    _db: db,
  };
}

// A film as it actually sits after insert-time enrichment: poster and network
// present, detail block empty, enriched_at already stamped.
function addMovie(env, { title, tmdbId, poster = '/have.jpg', network = 'Max', genres = null, withCast = true, complete = false, logo = null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, poster_url, network,
                        network_logo_url, genres, overview, runtime, enriched_at, created_at, updated_at)
     VALUES (?, 'next', 'patrick', 1, ?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, tmdbId, poster, network, logo,
        complete ? FILMS[tmdbId].genre : genres,
        complete ? 'already here' : null,
        complete ? FILMS[tmdbId].runtime : null,
        '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows').get().id);
  if (withCast) {
    // With an imdb_id already set, so the separate actor-imdb backfill pass —
    // which selects on `imdb_id IS NULL` and fetches by title — stays out of
    // the way. Only the movie detail pass is under test here.
    env._db.prepare('INSERT INTO actors (show_id, name, imdb_id, ord) VALUES (?, ?, ?, 0)')
      .run(id, `${title} Lead`, 'nm0000001');
  }
  return id;
}

const rowFor = (env, title) =>
  ({ ...env._db.prepare('SELECT * FROM shows WHERE LOWER(title) = LOWER(?)').get(title) });

const runEnrich = (env, body = {}) => enrichApi.onRequestPost({
  env,
  request: new Request(ORIGIN + '/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'session=sess' },
    body: JSON.stringify(body),
  }),
  waitUntil: () => {},
});

// ---------------------------------------------------------------- 1 + 2

console.log('\nThe normal pass reaches a film missing only its detail block');
{
  const env = makeEnv();
  // Exactly the production shape: poster, network, cast, enriched_at — and no
  // genres. Under the old artwork-only gate this row was unreachable forever.
  addMovie(env, { title: 'Sinners', tmdbId: 501 });
  // A film with nothing missing at all.
  addMovie(env, { title: 'Conclave', tmdbId: 502, complete: true });

  fetchLog = [];
  const res = await runEnrich(env);
  const body = await res.json();
  const sinners = rowFor(env, 'Sinners');
  const conclave = rowFor(env, 'Conclave');

  check('a movie with poster + network but no genres is selected', body.movieCandidates === 1,
    `movieCandidates=${body.movieCandidates}`);
  check('it comes back with genres', sinners.genres === 'Horror', `genres=${sinners.genres}`);
  check('and the rest of the detail block rides along', sinners.overview && sinners.runtime === 137,
    `overview=${sinners.overview} runtime=${sinners.runtime}`);
  check('a complete movie is not re-fetched at all', !fetchLog.some((u) => u.includes('/3/movie/502')),
    fetchLog.join(' '));
  check('and is left exactly as it was', conclave.overview === 'already here', `overview=${conclave.overview}`);
}

// ---------------------------------------------------------------- 3

console.log('\nGaps mode sees it, and counts it as remaining');
{
  const env = makeEnv();
  // Has cast, so the old gaps predicate (missing cast alone) skipped it.
  addMovie(env, { title: 'Sinners', tmdbId: 501, withCast: true });

  const before = await (await runEnrich(env, { mode: 'gaps', max_tmdb: 0 })).json();
  check('a dry run reports the film as remaining', before.remaining && before.remaining.movies === 1,
    JSON.stringify(before.remaining));

  const res = await (await runEnrich(env, { mode: 'gaps' })).json();
  check('gaps mode selects it despite it having cast', res.movieCandidates === 1,
    `movieCandidates=${res.movieCandidates}`);
  check('and fills the genres', rowFor(env, 'Sinners').genres === 'Horror');

  const after = await (await runEnrich(env, { mode: 'gaps', max_tmdb: 0 })).json();
  check('once filled it stops counting as remaining', after.remaining && after.remaining.movies === 0,
    JSON.stringify(after.remaining));
}

// ---------------------------------------------------------------- 4

console.log('\nPosters mode keeps its narrow artwork gate');
{
  const env = makeEnv();
  addMovie(env, { title: 'Sinners', tmdbId: 501 });                       // detail gap only
  addMovie(env, { title: 'Flow', tmdbId: 504, poster: null });            // genuine artwork gap

  const res = await (await runEnrich(env, { mode: 'posters' })).json();
  check('a detail-only gap is not pulled into the artwork batch', res.movieCandidates === 1,
    `movieCandidates=${res.movieCandidates}`);
  check('the film missing a poster is the one it took', rowFor(env, 'Flow').poster_url !== null);
  check('the detail-only film is left for the normal pass', rowFor(env, 'Sinners').genres === null);
}

// ---------------------------------------------------------------- 5

console.log('\nThe loop stops on the subrequest budget');
{
  const env = makeEnv();
  // More films than the budget can pay for, each needing a detail fetch.
  for (const id of [501, 502, 503, 504, 505]) {
    for (let n = 0; n < 12; n++) {
      addMovie(env, { title: `${FILMS[id].title} ${n}`, tmdbId: id });
    }
  }
  fetchLog = [];
  const res = await (await runEnrich(env)).json();
  check('it reports the budget as exhausted rather than running on', res.budgetExhausted === true,
    JSON.stringify(res));
  check('and stops well inside Cloudflare\'s per-request ceiling', res.subrequests <= 50,
    `subrequests=${res.subrequests}`);
}

// ---------------------------------------------------------------- 6

console.log('\nMovies get a service badge, from the provider that named the network');
{
  const env = makeEnv();
  addMovie(env, { title: 'Sinners', tmdbId: 501 });

  await runEnrich(env);
  check('the detail pass fills network_logo_url for a movie',
    rowFor(env, 'Sinners').network_logo_url === 'https://image.tmdb.org/t/p/w154/max-logo.jpg',
    `logo=${rowFor(env, 'Sinners').network_logo_url}`);
}

console.log('\nThe logo sweep drains films that predate the fix, and nothing else');
{
  const env = makeEnv();
  // Complete in every respect except the badge — invisible to MOVIE_GAP, which
  // is the whole reason the sweep exists.
  addMovie(env, { title: 'Sinners', tmdbId: 501, complete: true, logo: null });
  addMovie(env, { title: 'Conclave', tmdbId: 502, complete: true, logo: '/already.jpg' });

  const normal = await (await runEnrich(env)).json();
  check('the standing gate leaves a logo-only gap alone', normal.movieCandidates === 0,
    `movieCandidates=${normal.movieCandidates}`);

  const sweep = await (await runEnrich(env, { mode: 'logos' })).json();
  check('the sweep selects exactly the film missing its badge', sweep.movieCandidates === 1,
    `movieCandidates=${sweep.movieCandidates}`);
  check('and fills it', rowFor(env, 'Sinners').network_logo_url === 'https://image.tmdb.org/t/p/w154/max-logo.jpg');
  check('leaving a film that already had one untouched',
    rowFor(env, 'Conclave').network_logo_url === '/already.jpg');
}

console.log('\nA rent/buy-only film cannot churn the standing gate');
{
  const env = makeEnv();
  // No flatrate provider, so no logo will ever exist for it.
  addMovie(env, { title: 'Anora', tmdbId: 506, complete: true, logo: null });

  const first = await (await runEnrich(env)).json();
  check('it is not selected by the normal pass even once', first.movieCandidates === 0,
    `movieCandidates=${first.movieCandidates}`);

  // The sweep may take it (it is missing a logo) but must not be able to fill
  // it — the point is that this row never enters the standing rotation, which
  // runs on every member page load.
  await runEnrich(env, { mode: 'logos' });
  check('the sweep leaves it empty rather than inventing a badge',
    rowFor(env, 'Anora').network_logo_url === null);
  const again = await (await runEnrich(env)).json();
  check('and it still does not qualify for the standing gate afterwards', again.movieCandidates === 0,
    `movieCandidates=${again.movieCandidates}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
