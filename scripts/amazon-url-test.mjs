#!/usr/bin/env node
// Amazon URL normalization — the rule that decides whether a member's Watch
// button reaches the show or dumps them on the Prime Video home screen.
//
// The properties worth pinning are the negative ones. A rewrite that invents
// an id is worse than no rewrite at all: the member lands on an Amazon error
// page instead of somewhere they can search from.
//
// No network. Run: node scripts/amazon-url-test.mjs

import { normalizeAmazonUrl, amazonUrlLandsOnShow } from '../functions/_shared/amazon-urls.js';
import { normalizeHboMaxUrl } from '../functions/_shared/hbomax-urls.js';

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

const WORKING = 'https://watch.amazon.com/detail?gti=amzn1.dv.gti.d4bc0a58-139a-abbc-046b-d9ffcd25c463';

// The repair itself: same id, host that tvOS hands to Prime Video.
check('gp/video carrying a gti is moved to watch.amazon.com',
  normalizeAmazonUrl('https://www.amazon.com/gp/video/detail/amzn1.dv.gti.d4bc0a58-139a-abbc-046b-d9ffcd25c463'),
  WORKING);

// Watchmode appends autoplay params; they must not survive into the id.
check('query params are dropped rather than folded into the id',
  normalizeAmazonUrl('https://www.amazon.com/gp/video/detail/amzn1.dv.gti.d4bc0a58-139a-abbc-046b-d9ffcd25c463?autoplay=0&ref_=atv_dp'),
  WORKING);

check('a trailing slash does not become part of the id',
  normalizeAmazonUrl('https://www.amazon.com/gp/video/detail/amzn1.dv.gti.d4bc0a58-139a-abbc-046b-d9ffcd25c463/'),
  WORKING);

check('primevideo.com carrying a gti is moved too',
  normalizeAmazonUrl('https://www.primevideo.com/detail/amzn1.dv.gti.d4bc0a58-139a-abbc-046b-d9ffcd25c463'),
  WORKING);

// Already correct — must be left exactly alone, not re-wrapped.
check('a watch.amazon.com URL is returned untouched', normalizeAmazonUrl(WORKING), WORKING);

// The important refusals. An ASIN is not a gti: Amazon rejects it in the gti
// parameter, so rewriting one would manufacture a dead link.
const ASIN_URL = 'https://www.amazon.com/gp/video/detail/B08WJQ3XP5/';
check('an ASIN is never promoted into a gti', normalizeAmazonUrl(ASIN_URL), ASIN_URL);

const RETAIL = 'https://www.amazon.com/Saltburn-Barry-Keoghan/dp/B0CGHHFGBS';
check('a retail /dp/ page is left alone', normalizeAmazonUrl(RETAIL), RETAIL);

// primevideo.com's own opaque ids are not gtis and must not be treated as one.
const PV_ID = 'https://www.primevideo.com/detail/0OB9NDUVQKFRSYRSCHT2A784TI';
check('a primevideo.com opaque id is left alone', normalizeAmazonUrl(PV_ID), PV_ID);

// Everything that isn't Amazon.
const NETFLIX = 'https://www.netflix.com/title/81437051';
check('a non-Amazon URL is untouched', normalizeAmazonUrl(NETFLIX), NETFLIX);

const HBO = 'https://play.hbomax.com/show/e6e7bad9-d48d-4434-b334-7c651ffc4bdf';
check('an HBO Max URL is untouched', normalizeAmazonUrl(HBO), HBO);

// Never throws on junk — callers hand this whatever a member or vendor stored.
check('garbage is returned unchanged rather than throwing',
  normalizeAmazonUrl('not a url at all'), 'not a url at all');
check('null is returned unchanged', normalizeAmazonUrl(null), null);
check('empty string is returned unchanged', normalizeAmazonUrl(''), '');

// A lookalike host must not be treated as Amazon's.
const EVIL = 'https://amazon.com.example.net/gp/video/detail/amzn1.dv.gti.d4bc0a58-139a-abbc-046b-d9ffcd25c463';
check('a lookalike host is not rewritten', normalizeAmazonUrl(EVIL), EVIL);

// The predicate the Watch button reads.
check('landsOnShow is true for watch.amazon.com', amazonUrlLandsOnShow(WORKING), true);
check('landsOnShow is false for gp/video', amazonUrlLandsOnShow(ASIN_URL), false);
check('landsOnShow is false for junk', amazonUrlLandsOnShow('nope'), false);
check('landsOnShow is false for null', amazonUrlLandsOnShow(null), false);

// HBO Max: the same repair for a different vendor. The info page on
// www.hbomax.com / www.max.com carries the player's id, so the id moves onto
// play.hbomax.com; a page without one is left alone.
const POTTERY = 'https://play.hbomax.com/show/d883789c-c45e-4b1c-9145-d4d034af6f24';
check('hbomax info page moves to the player',
  normalizeHboMaxUrl('https://www.hbomax.com/show/d883789c-c45e-4b1c-9145-d4d034af6f24'), POTTERY);
check('hbomax tracking params are dropped',
  normalizeHboMaxUrl('https://www.hbomax.com/show/d883789c-c45e-4b1c-9145-d4d034af6f24?utm_source=universal_search'), POTTERY);
check('hbomax bare host and locale prefix',
  normalizeHboMaxUrl('https://hbomax.com/us/es/show/d883789c-c45e-4b1c-9145-d4d034af6f24/'), POTTERY);
check('old www.hbomax.com/shows/<slug>/<id> shape',
  normalizeHboMaxUrl('https://www.hbomax.com/shows/sex-and-the-city/2641fd06-387f-4d92-a322-accb8e180713'),
  'https://play.hbomax.com/show/2641fd06-387f-4d92-a322-accb8e180713');
check('old www.max.com/movies/<slug>/<id> shape is a movie',
  normalizeHboMaxUrl('https://www.max.com/movies/alex-edelman-just-for-us/7032329c-4bff-4456-92d3-4847ec61cfc1'),
  'https://play.hbomax.com/movie/7032329c-4bff-4456-92d3-4847ec61cfc1');
check('a player URL is untouched', normalizeHboMaxUrl(HBO), HBO);
const HBO_HOME = 'https://www.hbomax.com/';
check('an hbomax page with no id is untouched', normalizeHboMaxUrl(HBO_HOME), HBO_HOME);
const HBO_EVIL = 'https://www.hbomax.com.example.net/show/d883789c-c45e-4b1c-9145-d4d034af6f24';
check('an hbomax lookalike host is not rewritten', normalizeHboMaxUrl(HBO_EVIL), HBO_EVIL);
check('a non-HBO URL is untouched by the HBO rule', normalizeHboMaxUrl(NETFLIX), NETFLIX);
check('hbomax: garbage is returned unchanged', normalizeHboMaxUrl('not a url'), 'not a url');
check('hbomax: null is returned unchanged', normalizeHboMaxUrl(null), null);

if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nall amazon and hbo max url checks passed');
