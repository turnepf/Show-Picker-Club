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
//   6. Archived titles are in scope (Favorite Actors counts an archived title
//      rated 8+): an archived film with gaps is filled, cast included, an
//      archived sibling receives propagated data, and an archived series
//      enters the TV rotation only while it has a gap.
//
// Same harness as scripts/enrich-identity-test.mjs: functions copied to a temp
// dir as ES modules, schema.sql in node:sqlite behind a D1 shim, TMDB faked.

import { liftCopiesIntoTitles } from './lib/seed-titles.mjs';
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
const { rebuildTitles } = await import(join(sandbox, 'functions', '_shared/titles.js'));

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
  // Streams on several services at once, Prime ranked above Max.
  507: { title: 'Sing Sing', year: '2024-07-12', genre: 'Drama', runtime: 105, multi: true },
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
      flatrate: f.provider === null ? [] : (f.multi
        // Priority order the way TMDB answers: Prime first, Max further down.
        // A film whose card says Max must not be given Prime's badge.
        ? [{ provider_name: 'Amazon Prime Video', logo_path: '/prime-logo.jpg', display_priority: 1 },
           { provider_name: 'Max', logo_path: '/max-logo.jpg', display_priority: 5 }]
        : [{ provider_name: 'Max', logo_path: '/max-logo.jpg', display_priority: 1 }]),
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
  const tv = u.pathname.match(/^\/3\/tv\/(\d+)$/);
  if (tv) {
    if (tv[1] !== '700') return jsonRes({ success: false }, 404);
    return jsonRes({
      id: 700, name: 'The Rehearsal', first_air_date: '2022-07-15',
      poster_path: '/reh.jpg', overview: 'A series.', vote_average: 8.0, vote_count: 500,
      status: 'Returning Series', number_of_episodes: 12, number_of_seasons: 2,
      episode_run_time: [40], genres: [{ name: 'Comedy' }],
      networks: [{ name: 'HBO', logo_path: '/hbo.png' }],
      created_by: [], credits: { cast: [] },
      videos: { results: [] }, content_ratings: { results: [] },
      'watch/providers': { results: { US: { link: 'https://tmdb/watch',
        flatrate: [{ provider_name: 'Max', logo_path: '/max-logo.jpg', display_priority: 1 }] } } },
    });
  }
  if (u.pathname === '/3/search/tv') return jsonRes({ results: [] });
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
// `complete` means "nothing left for the pass to fill", which since migration
// 069 includes a written streaming_on — empty string counts, since the pass
// always writes one. Tests that want the streaming gap itself pass it as null.
function addMovie(env, { title, tmdbId, poster = '/have.jpg', network = 'Max', genres = null, withCast = true, complete = false, logo = null, streamingOn = complete ? '' : null }) {
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, poster_url, network,
                        network_logo_url, streaming_on, genres, overview, runtime, enriched_at, created_at, updated_at)
     VALUES (?, 'next', 'patrick', 1, ?, 'movie', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, tmdbId, poster, network, logo, streamingOn,
        complete ? FILMS[tmdbId].genre : genres,
        complete ? 'already here' : null,
        complete ? FILMS[tmdbId].runtime : null,
        '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z');
  const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id);
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
  ({ ...env._db.prepare('SELECT * FROM shows_v WHERE LOWER(title) = LOWER(?)').get(title) });

// These fixtures describe shows the pre-normalizing way, facts on the copy.
// Each run lifts them into the shared row first, as migration 076 did for
// production, since the passes read gaps from there and members read facts
// from there.
const runEnrich = async (env, body = {}) => {
  liftCopiesIntoTitles(env._db);
  await rebuildTitles(env);
  return enrichApi.onRequestPost({
  env,
  request: new Request(ORIGIN + '/api/enrich', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'session=sess' },
    body: JSON.stringify(body),
  }),
  waitUntil: () => {},
  });
};

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

console.log('\nTwo overlapping passes each get their own budget');
{
  // One isolate serves overlapping requests, and member pages fire
  // /api/enrich in the background. The count used to be a module-level
  // `let`: each pass reset it on entry and both incremented it, so one could
  // run past the cap while the other stopped early. Each pass must count
  // exactly what it alone spends.
  const fill = (env) => {
    for (const id of [501, 502, 503, 504, 505]) {
      for (let n = 0; n < 12; n++) addMovie(env, { title: `${FILMS[id].title} ${n}`, tmdbId: id });
    }
  };
  const solo = makeEnv(); fill(solo);
  const alone = await (await runEnrich(solo)).json();
  const a = makeEnv(); fill(a);
  const b = makeEnv(); fill(b);
  const [ra, rb] = await Promise.all([runEnrich(a), runEnrich(b)]).then((rs) => Promise.all(rs.map((r) => r.json())));
  check('each overlapping pass spends what a pass alone spends',
    ra.subrequests === alone.subrequests && rb.subrequests === alone.subrequests,
    `alone=${alone.subrequests} a=${ra.subrequests} b=${rb.subrequests}`);
  check('and neither passes the cap', ra.subrequests <= 50 && rb.subrequests <= 50);
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

// ---------------------------------------------------------------- 9

console.log('\nThe badge matches the network the card actually shows');
{
  const env = makeEnv();
  // Card says Max. TMDB ranks Prime first. Taking the top provider put
  // Amazon's logo on an HBO Max card in production (~22% of badged films).
  addMovie(env, { title: 'Sing Sing', tmdbId: 507, network: 'Max' });
  await runEnrich(env);
  check('it takes the logo of the row\'s own network, not the top-ranked one',
    rowFor(env, 'Sing Sing').network_logo_url === 'https://image.tmdb.org/t/p/w154/max-logo.jpg',
    `logo=${rowFor(env, 'Sing Sing').network_logo_url}`);
}
{
  const env = makeEnv();
  // Card says Hulu; TMDB doesn't list Hulu at all. A blank badge is correct —
  // a logo contradicting its own label is worse than none.
  addMovie(env, { title: 'Sing Sing', tmdbId: 507, network: 'Hulu' });
  await runEnrich(env);
  check('a network TMDB does not list gets no badge rather than a wrong one',
    rowFor(env, 'Sing Sing').network_logo_url === null,
    `logo=${rowFor(env, 'Sing Sing').network_logo_url}`);
}
{
  const env = makeEnv();
  // No network yet: the statement sets one from the primary provider, so the
  // badge may follow it — they agree by construction.
  addMovie(env, { title: 'Sing Sing', tmdbId: 507, network: null });
  await runEnrich(env);
  const r = rowFor(env, 'Sing Sing');
  check('a row with no network gets both, and they agree',
    r.network === 'Amazon Prime Video' && r.network_logo_url === 'https://image.tmdb.org/t/p/w154/prime-logo.jpg',
    `network=${r.network} logo=${r.network_logo_url}`);
}

// --------------------------------------------------------------- 10

console.log('\nWhere a title streams now sits beside the network, never over it');
{
  const env = makeEnv();
  // The member says Netflix. TMDB says Max. Both facts are kept: the member's
  // answer is theirs, TMDB's is current, and the UI shows the difference.
  addMovie(env, { title: 'Sing Sing', tmdbId: 507, network: 'Netflix' });
  await runEnrich(env);
  const r = rowFor(env, 'Sing Sing');
  check('the member\'s network is left exactly as they set it', r.network === 'Netflix',
    `network=${r.network}`);
  // Canonical names, matching the vocabulary `network` itself uses — TMDB
  // says "Max", the table says "HBO Max", and a member comparing the two
  // should not have to know they are the same service.
  check('and TMDB\'s current services are recorded alongside, canonicalized',
    r.streaming_on === 'Amazon Prime Video, HBO Max', `streaming_on=${r.streaming_on}`);
  check('no badge, since the card\'s own network is not among them',
    r.network_logo_url === null, `logo=${r.network_logo_url}`);
}
{
  const env = makeEnv();
  // A stale value must be replaced, not preserved — being current is this
  // column's entire job, so unlike everything beside it, it is not fill-only.
  const id = addMovie(env, { title: 'Sing Sing', tmdbId: 507, network: 'Netflix' });
  env._db.prepare('UPDATE shows SET streaming_on = ? WHERE id = ?').run('Peacock', id);
  await runEnrich(env);
  check('a stale list is overwritten rather than kept',
    rowFor(env, 'Sing Sing').streaming_on === 'Amazon Prime Video, HBO Max',
    `streaming_on=${rowFor(env, 'Sing Sing').streaming_on}`);
}
{
  const env = makeEnv();
  // Rent/buy only: TMDB was asked and named nothing. Empty string, not NULL —
  // "streams nowhere on a plan" is a different fact from "never asked".
  addMovie(env, { title: 'Anora', tmdbId: 506, network: 'Apple TV Store' });
  await runEnrich(env);
  check('a film streaming nowhere records an empty list, not null',
    rowFor(env, 'Anora').streaming_on === '', `streaming_on=${JSON.stringify(rowFor(env, 'Anora').streaming_on)}`);
}
{
  const env = makeEnv();
  // The TV pass is a separate UPDATE statement, so it gets its own check.
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, network, created_at, updated_at)
     VALUES ('The Rehearsal', 'watching', 'patrick', 0, 700, 'tv', 'Netflix', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
  ).run();
  await runEnrich(env);
  const r = rowFor(env, 'The Rehearsal');
  check('a series records its services too', r.streaming_on === 'HBO Max', `streaming_on=${r.streaming_on}`);
  check('and its member-set network survives', r.network === 'Netflix', `network=${r.network}`);
}
{
  const env = makeEnv();
  // Two members, one film: the list is a fact about the title, so it reaches
  // the copy the rotation didn't pick.
  addMovie(env, { title: 'Sing Sing', tmdbId: 507, network: 'Max' });
  env._db.prepare('INSERT INTO members (slug, name, first_name) VALUES (?, ?, ?)').run('quinn', 'Quinn D', 'Quinn');
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, poster_url, network, genres, enriched_at, created_at, updated_at)
     VALUES ('Sing Sing', 'next', 'quinn', 1, 507, 'movie', '/have.jpg', 'Max', 'Drama', '2026-09-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`
  ).run();
  await runEnrich(env);
  const copies = env._db.prepare("SELECT member_slug, streaming_on FROM shows_v WHERE LOWER(title)='sing sing'").all();
  check('every copy of the title carries the same list',
    copies.length === 2 && copies.every((c) => c.streaming_on === 'Amazon Prime Video, HBO Max'),
    JSON.stringify(copies));
}

// --------------------------------------------------------------- 11

console.log('\nFilms reach the streaming list without a sweep, and only once');
{
  const env = makeEnv();
  // Complete in every other respect. Without streaming_on in the gate this
  // film is invisible to the movie pass forever — the TV pass runs first and
  // spends the budget, so a movie only ever enters through MOVIE_GAP.
  addMovie(env, { title: 'Sing Sing', tmdbId: 507, network: 'Max', complete: true, streamingOn: null });
  const first = await (await runEnrich(env)).json();
  check('a film missing only its streaming list is selected', first.movieCandidates === 1,
    `movieCandidates=${first.movieCandidates}`);
  check('and receives it', rowFor(env, 'Sing Sing').streaming_on === 'Amazon Prime Video, HBO Max');

  const second = await (await runEnrich(env)).json();
  check('it does not qualify a second time', second.movieCandidates === 0,
    `movieCandidates=${second.movieCandidates}`);
}
{
  const env = makeEnv();
  // The churn question, which is why this clause is safe where the badge's is
  // not: a film TMDB lists nowhere still gets a written value (empty string),
  // so it drops out of the gate instead of re-qualifying on every page load.
  addMovie(env, { title: 'Anora', tmdbId: 506, network: 'Apple TV Store', complete: true, streamingOn: null });
  await runEnrich(env);
  check('a film TMDB lists nowhere still gets a written value',
    rowFor(env, 'Anora').streaming_on === '', `streaming_on=${JSON.stringify(rowFor(env, 'Anora').streaming_on)}`);
  const again = await (await runEnrich(env)).json();
  check('so it cannot churn the gate', again.movieCandidates === 0,
    `movieCandidates=${again.movieCandidates}`);
}

// --------------------------------------------------------------- 12

console.log('\nArchived titles are enriched too, since Favorite Actors counts them');
{
  const env = makeEnv();
  // An archived film imported bare: no cast, no detail. Favorite Actors
  // counts an archived title rated 8+, so a filter on archived = 0 here left
  // exactly those titles contributing nobody.
  const id = addMovie(env, { title: 'Sinners', tmdbId: 501, withCast: false });
  env._db.prepare('UPDATE shows SET archived = 1 WHERE id = ?').run(id);

  const res = await (await runEnrich(env)).json();
  check('an archived film with gaps is selected', res.movieCandidates === 1,
    `movieCandidates=${res.movieCandidates}`);
  check('it gets its detail block', rowFor(env, 'Sinners').genres === 'Horror');
  const cast = env._db.prepare('SELECT name FROM actors_v WHERE show_id = ?').all(id).map((r) => r.name);
  check('and its cast, which the movie pass never used to write', cast.includes('Sinners Lead'),
    JSON.stringify(cast));
  const again = await (await runEnrich(env)).json();
  check('once whole it drops out of the gate', again.movieCandidates === 0,
    `movieCandidates=${again.movieCandidates}`);
}
{
  const env = makeEnv();
  // A live copy is the one the pass picks; an archived sibling of the same
  // title must receive the same catalog data rather than being skipped.
  addMovie(env, { title: 'Sinners', tmdbId: 501, withCast: false });
  env._db.prepare('INSERT INTO members (slug, name, first_name) VALUES (?, ?, ?)').run('amy', 'Amy', 'Amy');
  env._db.prepare(
    `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, archived, enriched_at)
     VALUES ('Sinners', 'recommending', 'amy', 1, 501, 'movie', 1, '2026-09-20T00:00:00Z')`
  ).run();
  const archivedId = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id);
  await runEnrich(env);
  const r = { ...env._db.prepare('SELECT * FROM shows_v WHERE id = ?').get(archivedId) };
  check('an archived sibling receives the propagated detail', r.genres === 'Horror' && r.poster_url,
    `genres=${r.genres} poster=${r.poster_url}`);
  const cast = env._db.prepare('SELECT COUNT(*) AS n FROM actors_v WHERE show_id = ?').get(archivedId).n;
  check('and the cast', Number(cast) > 0, `cast=${cast}`);
}
{
  const env = makeEnv();
  const addTv = (episodes, withActor) => {
    env._db.prepare(
      `INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, archived, episodes_released, enriched_at)
       VALUES ('The Rehearsal', 'watching', 'patrick', 0, 700, 'tv', 1, ?, '2026-09-01T00:00:00Z')`
    ).run(episodes);
    const id = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id);
    if (withActor) env._db.prepare('INSERT INTO actors (show_id, name, imdb_id, ord) VALUES (?, ?, ?, 0)').run(id, 'Nathan Fielder', 'nm1');
    return id;
  };
  // Whole, archived: the normal rotation must not spend budget refreshing it —
  // that cycle exists to keep live lists' next-season dates current.
  addTv(12, true);
  let res = await (await runEnrich(env)).json();
  check('a whole archived series stays out of the normal rotation', res.tvCandidates === 0,
    `tvCandidates=${res.tvCandidates}`);
  // Archived with a gap: in, until it is filled. A fresh library, shared
  // rows included (gaps are read from those since normalizing step 3c).
  env._db.prepare('DELETE FROM shows').run();
  env._db.prepare('DELETE FROM titles').run();
  env._db.prepare('DELETE FROM title_cast').run();
  const gapId = addTv(null, true);
  res = await (await runEnrich(env)).json();
  check('an archived series with a gap is selected', res.tvCandidates === 1,
    `tvCandidates=${res.tvCandidates}`);
  const ep = env._db.prepare('SELECT episodes_released FROM shows_v WHERE id = ?').get(gapId).episodes_released;
  check('and filled', ep === 12, `episodes_released=${ep}`);
}

// --------------------------------------------------------------- 12

console.log('\nMovies mode refreshes complete films, oldest first');
{
  const env = makeEnv();
  // Complete in every respect, so MOVIE_GAP never selects it again — which is
  // exactly how a film's streaming services froze. It streams on Peacock as
  // far as this row knows; TMDB now says Max.
  const stale = addMovie(env, { title: 'Conclave', tmdbId: 502, complete: true });
  env._db.prepare(`UPDATE shows SET streaming_on = 'Peacock', vote_count = 10, enriched_at = '2026-08-01T00:00:00Z' WHERE id = ?`).run(stale);
  // Complete and refreshed more recently: the rotation takes the older one first.
  addMovie(env, { title: 'Flow', tmdbId: 504, complete: true });
  // Complete but archived: not worth a fetch to learn where it streams now.
  const archived = addMovie(env, { title: 'Nickel Boys', tmdbId: 505, complete: true });
  env._db.prepare('UPDATE shows SET archived = 1 WHERE id = ?').run(archived);
  // A series, to prove the TV pass stays out of the way.
  env._db.prepare(`INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type) VALUES ('The Rehearsal', 'watching', 'patrick', 0, 700, 'tv')`).run();

  const normal = await (await runEnrich(env)).json();
  check('the default mode still leaves complete films alone', normal.movieCandidates === 0,
    `movieCandidates=${normal.movieCandidates}`);

  fetchLog = [];
  const res = await (await runEnrich(env, { mode: 'movies', max_tmdb: 1 })).json();
  check('movies mode selects a complete film', res.movieCandidates === 1,
    `movieCandidates=${res.movieCandidates}`);
  check('the oldest-enriched one first', fetchLog.some((u) => u.includes('/3/movie/502')),
    fetchLog.join(' '));
  const c = rowFor(env, 'Conclave');
  check('its streaming services are brought up to date', c.streaming_on === 'HBO Max',
    `streaming_on=${c.streaming_on}`);
  check('and its vote count converges', c.vote_count === 900, `vote_count=${c.vote_count}`);
  // The member's service is theirs and stays. The overview is the film's,
  // on its shared row, so a refresh brings TMDB's current text rather than
  // keeping whatever an earlier pass left (docs/INVARIANTS.md §29).
  check('the member\'s own fields are untouched', c.network === 'Max', `network=${c.network}`);
  check('the film\'s facts are TMDB\'s current ones', c.overview === 'Conclave — the overview.', `overview=${c.overview}`);
  check('the TV pass does not run', !fetchLog.some((u) => u.includes('/3/tv/')), fetchLog.join(' '));

  // Conclave now carries today's stamp, so the next round moves on.
  fetchLog = [];
  await runEnrich(env, { mode: 'movies', max_tmdb: 1 });
  check('the next round rotates to the next-oldest film', fetchLog.some((u) => u.includes('/3/movie/504')),
    fetchLog.join(' '));

  fetchLog = [];
  const all = await (await runEnrich(env, { mode: 'movies' })).json();
  check('a complete archived film is not in the rotation', all.movieCandidates === 2
    && !fetchLog.some((u) => u.includes('/3/movie/505')), `movieCandidates=${all.movieCandidates}`);
}

// --------------------------------------------------------------- 13

console.log('\nEmpty data is filled before stale data is refreshed');
{
  const env = makeEnv();
  // Complete and the oldest stamp in the library — plain oldest-first order
  // would take it first.
  // Its own entry (699): a gap belongs to the show, not the copy, so two
  // copies of one entry can't be one complete and one not.
  env._db.prepare(`INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, poster_url,
                     episodes_released, enriched_at) VALUES ('Old Complete', 'watching', 'patrick', 0, 699, 'tv',
                     '/p.jpg', 12, '2026-08-01T00:00:00Z')`).run();
  const complete = Number(env._db.prepare('SELECT MAX(id) AS id FROM shows_v').get().id);
  env._db.prepare(`INSERT INTO actors (show_id, name, imdb_id, ord) VALUES (?, 'Lead', 'nm0000001', 0)`).run(complete);
  // Added two days ago with no poster, cast or episode count: the newest
  // stamp, so it used to wait behind every other row in the rotation. The
  // fake TMDB entry has no cast either, so it stays a gap after its turn —
  // exactly the placeholder-entry case that must not hog the queue.
  env._db.prepare(`INSERT INTO shows (title, list, member_slug, movie, tmdb_id, tmdb_type, enriched_at)
                   VALUES ('The Rehearsal', 'watching', 'patrick', 0, 700, 'tv', datetime('now', '-2 days'))`).run();
  const stamp = (title) => env._db.prepare('SELECT enriched_at FROM shows_v WHERE title = ?').get(title).enriched_at;
  const before = stamp('Old Complete');

  await runEnrich(env, { max_tmdb: 1 });
  check('a row with a gap goes ahead of an older complete one',
    stamp('Old Complete') === before && stamp('The Rehearsal') !== null
      && rowFor(env, 'The Rehearsal').poster_url === 'https://image.tmdb.org/t/p/w500/reh.jpg',
    `old=${stamp('Old Complete')} new=${stamp('The Rehearsal')}`);

  // Still castless after its turn. Tried minutes ago, so it waits its turn by
  // age instead of taking the front slot again.
  await runEnrich(env, { max_tmdb: 1 });
  check('a gap TMDB could not fill does not take the front slot again in the same run',
    stamp('Old Complete') !== before, `old=${stamp('Old Complete')}`);
}
{
  const env = makeEnv();
  // Movies mode: a complete film with the oldest stamp, and a film missing
  // its detail block tried two days ago.
  addMovie(env, { title: 'Conclave', tmdbId: 502, complete: true });
  const gap = addMovie(env, { title: 'Sinners', tmdbId: 501 });
  env._db.prepare(`UPDATE shows SET enriched_at = datetime('now', '-2 days') WHERE id = ?`).run(gap);
  fetchLog = [];
  await runEnrich(env, { mode: 'movies', max_tmdb: 1 });
  check('movies mode fills an incomplete film before refreshing a complete one',
    fetchLog.some((u) => u.includes('/3/movie/501')) && !fetchLog.some((u) => u.includes('/3/movie/502')),
    fetchLog.join(' '));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
