// Tests for the canonical network table — functions/_shared/networks.js, and
// the copy of it the iOS picker carries.
//
//   node scripts/networks-test.mjs
//
// Written when the UK and Australian services were added (2026-08), which
// roughly doubled the table and made both of its failure modes cheap to hit:
//
//   1. **A name claimed twice.** The alias index is a Map built in list order,
//      so a duplicate doesn't error — the later entry silently wins and every
//      row that used to canonicalize one way now canonicalizes the other. This
//      is the shape of the Apple TV / Apple TV+ collision the module's own
//      comments are about, and it can arrive by accident: the US ABC folds into
//      Hulu, and the Australian ABC is one careless alias away from stealing it.
//   2. **A network not reaching the apps.** The picker used to be a literal in
//      Models.swift, so MGM+ went missing from it while the server knew about
//      the service. The apps now fetch `networkCatalog()` from /api/networks,
//      which moves the risk rather than removing it: the payload has to carry
//      every entry, in sections a client can group by consecutive runs, and
//      the Swift seed left behind for a first offline launch must never name a
//      service the server wouldn't canonicalize.
//
// Also pins that a network can't be priced under a name the DB never stores —
// a typo'd key in DEFAULT_PRICE_CENTS reads as "nobody has priced this yet"
// rather than as an error.
//
// The client half of this — what happens when the payload is empty, junk, or
// carries a section this build has never heard of — is
// ShowPickerCore/Tests/ShowPickerCoreTests/NetworkCatalogTests.swift, which
// runs on the same PR.
//
// Pure module reads, no database, no network.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = mkdtempSync(join(tmpdir(), 'networks-'));
cpSync(join(repoRoot, 'functions'), join(sandbox, 'functions'), { recursive: true });
writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}');

const {
  NETWORKS, DEFAULT_PRICE_CENTS, canonicalNetwork, knownNetwork,
  networkFromUrl, networkSearchUrl, isStorefront, networkCatalog,
} = await import(join(sandbox, 'functions', '_shared', 'networks.js'));

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

console.log('\n== no name is claimed by two entries');
{
  // Every string that can resolve to a canonical: the stored names themselves
  // plus every alias, lowercased the way the index lowercases them.
  const claims = new Map();
  const dupes = [];
  for (const n of NETWORKS) {
    for (const name of [n.stored, ...n.aliases]) {
      const key = name.trim().toLowerCase();
      if (claims.has(key) && claims.get(key) !== n.stored) {
        dupes.push(`"${name}" → ${claims.get(key)} and ${n.stored}`);
      }
      claims.set(key, n.stored);
    }
  }
  check('no alias or stored name resolves to two different networks',
        dupes.length === 0, dupes.join('; '));

  const domainClaims = new Map();
  const domainDupes = [];
  for (const n of NETWORKS) {
    for (const d of n.domains || []) {
      const key = d.trim().toLowerCase();
      if (domainClaims.has(key)) domainDupes.push(`${d} → ${domainClaims.get(key)} and ${n.stored}`);
      domainClaims.set(key, n.stored);
    }
  }
  check('no domain is claimed by two networks', domainDupes.length === 0, domainDupes.join('; '));

  const storedDupes = NETWORKS
    .map(n => n.stored)
    .filter((s, i, all) => all.indexOf(s) !== i);
  check('no stored name appears twice', storedDupes.length === 0, storedDupes.join(', '));
}

console.log('\n== every entry resolves to itself');
{
  const broken = NETWORKS.filter(n => canonicalNetwork(n.stored) !== n.stored).map(n => n.stored);
  check('canonicalNetwork is a fixed point on every stored name', broken.length === 0, broken.join(', '));

  const badAlias = [];
  for (const n of NETWORKS) {
    for (const a of n.aliases) {
      if (canonicalNetwork(a) !== n.stored) badAlias.push(`${a} → ${canonicalNetwork(a)}, want ${n.stored}`);
      // Case and surrounding whitespace are the two things member input always
      // varies on, and the index is built lowercased for exactly that reason.
      if (knownNetwork(`  ${a.toUpperCase()}  `) !== n.stored) badAlias.push(`${a} fails case/space folding`);
    }
  }
  check('every alias folds to its canonical, whatever the case', badAlias.length === 0, badAlias.slice(0, 4).join('; '));

  const noSearch = NETWORKS.filter(n => !networkSearchUrl(n.stored, 'Test Title')).map(n => n.stored);
  check('every network has a search fallback', noSearch.length === 0, noSearch.join(', '));

  const badDomain = [];
  for (const n of NETWORKS) {
    for (const d of n.domains || []) {
      // Storefronts share hosts with subscriptions by design (tv.apple.com),
      // which is why they declare no domains; anything that does declare one
      // has to answer for it.
      if (networkFromUrl(`https://www.${d}/some/path`) !== n.stored) {
        badDomain.push(`${d} → ${networkFromUrl(`https://www.${d}/x`)}, want ${n.stored}`);
      }
    }
  }
  check('every declared domain maps back to its network', badDomain.length === 0, badDomain.join('; '));
}

console.log('\n== the collisions the table exists to prevent');
{
  // The US ABC is a Hulu sub-brand; the Australian one is its own service. If
  // ABC iview ever takes the bare name, every "ABC" row in the club silently
  // moves to an Australian broadcaster.
  check('bare "ABC" still means the US network on Hulu', canonicalNetwork('ABC') === 'Hulu', canonicalNetwork('ABC'));
  check('"ABC (AU)" — what TMDB calls the Australian one — is iview',
        canonicalNetwork('ABC (AU)') === 'ABC iview', canonicalNetwork('ABC (AU)'));
  // BBC America is an AMC+ channel, not a route to iPlayer.
  check('"BBC America" stays on AMC+', canonicalNetwork('BBC America') === 'AMC+', canonicalNetwork('BBC America'));
  check('"BBC" means iPlayer', canonicalNetwork('BBC') === 'BBC iPlayer', canonicalNetwork('BBC'));
  // The pre-existing pair, still holding.
  check('"Apple TV" is the subscription, not the store',
        canonicalNetwork('Apple TV') === 'Apple TV+', canonicalNetwork('Apple TV'));
  check('an unknown name is not invented into a network', knownNetwork('Channel 12 Toledo') === null);
}

console.log('\n== prices are keyed to names the DB actually stores');
{
  const stored = new Set(NETWORKS.map(n => n.stored));
  const orphans = Object.keys(DEFAULT_PRICE_CENTS).filter(k => !stored.has(k));
  check('no default price is keyed to a name no network stores', orphans.length === 0, orphans.join(', '));

  const pricedStorefronts = Object.keys(DEFAULT_PRICE_CENTS).filter(isStorefront);
  check('storefronts carry no monthly price', pricedStorefronts.length === 0, pricedStorefronts.join(', '));

  // Zero means "we know this is free"; absent means "nobody has priced it".
  // The free-to-air catch-up services are the second-largest group of zeroes
  // after Pluto TV, and reading as unpriced would put a "set a price" prompt on
  // a service that has none.
  const free = ['BBC iPlayer', 'ITVX', 'Channel 4', 'Channel 5', 'ABC iview', 'SBS On Demand', '9Now', '7plus', '10 play'];
  const notZero = free.filter(n => DEFAULT_PRICE_CENTS[n] !== 0);
  check('free-to-air catch-up services are priced at zero, not left absent',
        notZero.length === 0, notZero.join(', '));

  // Paid services billed in another currency stay unpriced on purpose — the
  // audit sums US cents, and a converted guess would be wrong in the sum.
  const foreignPaid = ['NOW', 'Stan', 'Binge', 'Foxtel'];
  const guessed = foreignPaid.filter(n => DEFAULT_PRICE_CENTS[n] != null);
  check('non-US paid services carry no US-cent guess', guessed.length === 0, guessed.join(', '));
}

console.log('\n== the catalog the apps fetch');
{
  const catalog = networkCatalog();
  const stored = NETWORKS.map(n => n.stored);

  check('every network reaches the catalog', catalog.networks.length === stored.length,
        `${catalog.networks.length} vs ${stored.length}`);
  const missing = stored.filter(s => !catalog.networks.some(n => n.stored === s));
  check('and none is dropped on the way', missing.length === 0, missing.join(', '));

  // A client groups *consecutive* entries by section, so a section that
  // appears in two runs would render as two headers with the same name.
  const runs = [];
  for (const n of catalog.networks) {
    if (!runs.length || runs[runs.length - 1] !== n.section) runs.push(n.section);
  }
  check('each section is one consecutive run', new Set(runs).size === runs.length, runs.join(' | '));
  check('the first group is unlabelled', runs[0] === null, String(runs[0]));
  check('storefronts land in their own section last',
        runs[runs.length - 1] === 'Rent or buy' && catalog.networks.filter(n => n.storefront).length === 3,
        runs.join(' | '));

  // A region on an entry that REGION_SECTIONS doesn't know would otherwise
  // vanish from every picker. networkCatalog() emits it under its raw key
  // rather than dropping it, and this is what notices.
  const known = [null, 'United Kingdom', 'Australia', 'Rent or buy'];
  const strays = [...new Set(catalog.networks.map(n => n.section))].filter(s => !known.includes(s));
  check('no entry carries a region with no section title', strays.length === 0, strays.join(', '));

  check('every entry has a display string', catalog.networks.every(n => n.display && n.stored));

  // Order inside a section is alphabetical rather than however NETWORKS
  // happens to be arranged, so appending a service to the array can't drop it
  // in the middle of a member's picker. Case-insensitive on the label a client
  // draws: "Amazon Prime Video" before "AMC+", where a member looks for it.
  const unsorted = [];
  for (const section of new Set(catalog.networks.map(n => n.section))) {
    const labels = catalog.networks.filter(n => n.section === section).map(n => n.display.toLowerCase());
    const sorted = [...labels].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (labels.join('|') !== sorted.join('|')) unsorted.push(section === null ? '(unlabelled)' : section);
  }
  check('each section is alphabetical', unsorted.length === 0, unsorted.join(', '));
  check('the version changes with the list',
        networkCatalog().version === catalog.version &&
        catalogVersionOf([...catalog.networks].reverse()) !== catalog.version);

  function catalogVersionOf(networks) {
    // Same shape the endpoint returns, rebuilt from a permuted list — the
    // version has to be a function of content *and* order, since order is what
    // a picker renders.
    const text = networks.map(n => `${n.stored}|${n.display}|${n.section || ''}|${n.storefront}`).join('\n');
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return `${networks.length}-${h.toString(16)}`;
  }
}

console.log('\n== the endpoint, including the repeat pull');
{
  // Clients try the server every time they show a picker rather than once per
  // launch, so the cheap answer to "still the same list?" is load-bearing: it
  // is what makes trying that often reasonable.
  const { onRequestGet } = await import(join(sandbox, 'functions', 'api', 'networks.js'));
  const call = (headers = {}) => onRequestGet({ request: new Request('https://showpicker.club/api/networks', { headers }) });

  const first = await call();
  const etag = first.headers.get('ETag');
  const body = await first.json();
  check('a cold request serves the list', first.status === 200 && body.networks.length > 0);
  check('with an ETag that is the catalog version', etag === `"${body.version}"`, String(etag));
  check('and a cacheable Cache-Control', /max-age=\d+/.test(first.headers.get('Cache-Control') || ''));

  const repeat = await call({ 'If-None-Match': etag });
  check('an unchanged list answers 304', repeat.status === 304, String(repeat.status));
  check('and sends no body with it', (await repeat.text()) === '');

  // A cache in the middle may weaken the validator; the client still gets its
  // 304 rather than re-downloading the list on every picker.
  const weak = await call({ 'If-None-Match': `W/${etag}` });
  check('a weakened validator still matches', weak.status === 304, String(weak.status));

  const stale = await call({ 'If-None-Match': '"1-deadbeef"' });
  check('a stale validator gets the full list', stale.status === 200 &&
        (await stale.json()).networks.length === body.networks.length);
}

console.log('\n== the iOS seed is a fallback, not a second source of truth');
{
  // The apps fetch /api/networks, so the Swift list is only what a first
  // launch with no signal shows. It is allowed to be *shorter* than the
  // server's — that's the whole point, a new network arrives without a build.
  // What it must never be is *wrong*: a name here that the server doesn't
  // canonicalize would write an unrecognized value into shows.network.
  const swift = readFileSync(
    join(repoRoot, 'ShowPickerCore/Sources/ShowPickerCore/NetworkCatalog.swift'), 'utf8');
  const seedBlock = swift.split('public static let bundled')[1] || '';
  const seeded = [...seedBlock.matchAll(/NetworkOption\("([^"]+)"/g)].map(m => m[1]);

  check('the seed was found and is not empty', seeded.length > 0, String(seeded.length));
  const stored = new Set(NETWORKS.map(n => n.stored));
  const unknown = seeded.filter(n => !stored.has(n));
  check('every seeded name is one the server canonicalizes', unknown.length === 0, unknown.join(', '));
  check('the seed does not repeat a name', new Set(seeded).size === seeded.length);

  // Nothing may reintroduce a hardcoded picker list in the app target.
  const models = readFileSync(join(repoRoot, 'ios/ShowPickerIOS/Models.swift'), 'utf8');
  check('the app no longer hardcodes the picker',
        !/let (CANONICAL|US|UK|AU|STOREFRONT)_NETWORKS/.test(models));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
