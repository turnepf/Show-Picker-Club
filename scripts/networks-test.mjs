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
//   2. **The Swift copy drifting.** ios/ShowPickerIOS/Models.swift mirrors
//      NETWORKS[].stored for the picker, with no compiler anywhere to notice
//      when the two disagree. MGM+ had already gone missing from it once, so a
//      member on MGM+ couldn't pick their own service.
//
// Also pins that a network can't be priced under a name the DB never stores —
// a typo'd key in DEFAULT_PRICE_CENTS reads as "nobody has priced this yet"
// rather than as an error.
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
  networkFromUrl, networkSearchUrl, isStorefront,
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

console.log('\n== the iOS picker knows every network the server does');
{
  const swift = readFileSync(join(repoRoot, 'ios/ShowPickerIOS/Models.swift'), 'utf8');
  // Each region array in Models.swift, concatenated the way CANONICAL_NETWORKS
  // concatenates them.
  const listNames = ['US_NETWORKS', 'UK_NETWORKS', 'AU_NETWORKS', 'STOREFRONT_NETWORKS'];
  const fromSwift = [];
  for (const name of listNames) {
    const m = swift.match(new RegExp(`let ${name}: \\[String\\] = \\[([^\\]]*)\\]`));
    if (!m) { fromSwift.push(`<missing ${name}>`); continue; }
    for (const line of m[1].split('\n')) {
      const q = line.match(/"([^"]+)"/);
      if (q) fromSwift.push(q[1]);
    }
  }
  const fromServer = NETWORKS.map(n => n.stored);
  const missing = fromServer.filter(n => !fromSwift.includes(n));
  const extra = fromSwift.filter(n => !fromServer.includes(n));
  check('the picker offers every server network', missing.length === 0, missing.join(', '));
  check('and offers nothing the server would not canonicalize', extra.length === 0, extra.join(', '));

  check('CANONICAL_NETWORKS is still the concatenation of the region lists',
        /let CANONICAL_NETWORKS: \[String\] = US_NETWORKS \+ UK_NETWORKS \+ AU_NETWORKS \+ STOREFRONT_NETWORKS/.test(swift));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
