#!/usr/bin/env node
// lookupWatchmodeUrl — the Watch-link lookup the add and edit paths fire in
// the background. A row pinned to a TMDB entry must be looked up by that
// entry: a name search takes Watchmode's first hit among every show of that
// name, which on a remade title is the other show, and its link then lands
// on every copy of ours.
//
// No network: fetch is stubbed. Run: node scripts/watchmode-lookup-test.mjs

import { lookupWatchmodeUrl } from '../functions/_shared/watch-providers.js';

let failures = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) {
    failures++;
    console.error(`FAIL ${name}\n  expected: ${expected}\n  actual:   ${actual}`);
  } else {
    console.log(`ok   ${name}`);
  }
}

const env = { WATCHMODE_API_KEY: 'test' };
let searches = [];
globalThis.fetch = async (url) => {
  const u = new URL(url);
  if (u.pathname === '/v1/search/') {
    searches.push(u.searchParams);
    return Response.json({ title_results: [{ id: 42 }] });
  }
  if (u.pathname === '/v1/title/42/sources/') {
    return Response.json([
      { region: 'US', type: 'sub', name: 'Netflix', web_url: 'https://www.netflix.com/title/123' },
    ]);
  }
  return new Response('not found', { status: 404 });
};

async function lookup(...args) {
  searches = [];
  const url = await lookupWatchmodeUrl(env, ...args);
  return { url, search: searches[0] };
}

{
  const { url, search } = await lookup('Little House on the Prairie', 'Netflix', false, { tmdb_id: 1234, tmdb_type: 'tv' });
  check('a pinned TV row searches by tmdb_tv_id', search.get('search_field'), 'tmdb_tv_id');
  check('…with its own id', search.get('search_value'), '1234');
  check('…and returns the service link', url, 'https://www.netflix.com/title/123');
}
{
  const { search } = await lookup('Heat', 'Netflix', true, { tmdb_id: 949, tmdb_type: 'movie' });
  check('a pinned movie searches by tmdb_movie_id', search.get('search_field'), 'tmdb_movie_id');
}
{
  const { search } = await lookup('Heat', 'Netflix', true, { tmdb_id: 949 });
  check('a pin with no type falls back to the movie flag', search.get('search_field'), 'tmdb_movie_id');
}
{
  const { search } = await lookup('Some Old Show', 'Netflix', false, { tmdb_id: null });
  check('an unpinned row still searches by name', search.get('search_field'), 'name');
  check('…filtered to TV', search.get('types'), 'tv_series,tv_miniseries');
}
{
  const { search } = await lookup('Some Old Show', 'Netflix', false);
  check('callers that pass no pin still work', search.get('search_field'), 'name');
}
{
  const { url } = await lookup('Little House on the Prairie', 'Hulu', false, { tmdb_id: 1234, tmdb_type: 'tv' });
  check('a service Watchmode does not list returns null', url, null);
}
{
  const { url, search } = await lookup('Anything', 'Netflix', false, { tmdb_id: 1 });
  check('no key, no call', await lookupWatchmodeUrl({}, 'Anything', 'Netflix', false, { tmdb_id: 1 }), null);
  check('(sanity) the keyed call above did search', !!search && !!url, true);
}

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall passed');
