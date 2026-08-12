// Canonical network list — the source of truth for what to store, what to
// show in the dropdown, and which alias names to fold into each canonical
// when migrating or matching.
//
// stored:    exact string written to shows.network. Picked to be the modern
//            streaming-service brand so URL templates stay coherent over time.
// display:   what appears in the Add / Suggest dropdowns. Includes the
//            sub-brand hint in parens so members who think "I watch this on
//            CBS" find their way to Paramount+.
// aliases:   older or sub-brand names that should be folded into this
//            canonical during migration and when matching user input. Lower
//            cased on comparison.
// domains:   hostnames that uniquely identify this network. Used by
//            networkFromUrl() to auto-correct the stored network when a
//            pasted URL disagrees with the dropdown pick.
// search:    fallback URL used when the user picks a network but doesn't
//            paste a deep link. Optional { param } means the title gets
//            appended as a query param; bare bases just open the network's
//            search page with the title typed in.

export const NETWORKS = [
  {
    stored: 'Netflix',
    display: 'Netflix',
    aliases: [],
    domains: ['netflix.com'],
    search: { base: 'https://www.netflix.com/search' },
  },
  {
    stored: 'HBO Max',
    display: 'HBO Max (including Discovery, Cartoon Network, Adult Swim, TNT, TBS, truTV, CNN)',
    aliases: ['HBO', 'Max', 'Discovery', 'Discovery+', 'Cartoon Network', 'Adult Swim', 'TNT', 'TBS', 'truTV', 'CNN'],
    domains: ['max.com', 'hbomax.com', 'hbo.com'],
    search: { base: 'https://play.hbomax.com/search', param: 'q' },
  },
  {
    stored: 'Apple TV+',
    display: 'Apple TV+',
    aliases: ['Apple TV', 'AppleTV+', 'AppleTV', 'Apple TV Plus'],
    domains: ['tv.apple.com', 'apple.co'],
    search: { base: 'https://tv.apple.com/search', param: 'term' },
  },
  {
    stored: 'Hulu',
    display: 'Hulu (including FX, FXX, ABC, National Geographic, Freeform)',
    aliases: ['FX', 'FXX', 'ABC', 'National Geographic', 'Nat Geo', 'Freeform'],
    domains: ['hulu.com'],
    search: { base: 'https://www.hulu.com/search' },
  },
  {
    stored: 'Paramount+',
    display: 'Paramount+ (including CBS, MTV, Comedy Central, Nickelodeon, BET, Showtime)',
    aliases: ['Paramount', 'Paramount Plus', 'CBS', 'MTV', 'Comedy Central', 'Nickelodeon', 'BET', 'Showtime', 'Smithsonian Channel'],
    domains: ['paramountplus.com', 'paramount.com', 'cbs.com', 'sho.com', 'showtime.com'],
    search: { base: 'https://www.paramountplus.com/search' },
  },
  {
    stored: 'Peacock',
    display: 'Peacock (including NBC, Bravo, USA, Syfy, Oxygen, E!)',
    aliases: ['NBC', 'Bravo', 'USA', 'USA Network', 'Syfy', 'SyFy', 'Oxygen', 'E!', 'Peacock Premium', 'Peacock Premium Plus'],
    domains: ['peacocktv.com', 'nbc.com', 'bravotv.com', 'usanetwork.com', 'syfy.com'],
    search: { base: 'https://www.peacocktv.com/watch/search' },
  },
  {
    stored: 'Amazon Prime Video',
    display: 'Amazon Prime Video (including Freevee)',
    aliases: ['Amazon', 'Amazon Prime', 'Prime Video', 'Freevee'],
    domains: ['amazon.com', 'primevideo.com'],
    search: { base: 'https://www.amazon.com/s', param: 'k', extra: 'i=instant-video' },
  },
  {
    stored: 'Disney+',
    display: 'Disney+ (including Marvel, Star Wars, Pixar, National Geographic)',
    aliases: ['Disney', 'Disney Plus', 'Marvel', 'Star Wars', 'Pixar'],
    domains: ['disneyplus.com'],
    search: { base: 'https://www.disneyplus.com/browse/search' },
  },
  {
    stored: 'Starz',
    display: 'Starz',
    aliases: [],
    domains: ['starz.com'],
    search: { base: 'https://www.starz.com/search', param: 'q' },
  },
  {
    stored: 'AMC+',
    display: 'AMC+ (including AMC, BBC America, IFC, Sundance, Shudder)',
    aliases: ['AMC', 'BBC America', 'IFC', 'Sundance', 'Shudder'],
    domains: ['amcplus.com', 'amc.com', 'bbcamerica.com', 'ifc.com', 'sundancenow.com', 'shudder.com'],
    search: { base: 'https://www.amcplus.com/search', param: 'q' },
  },
  {
    stored: 'Food Network',
    display: 'Food Network',
    aliases: [],
    domains: ['foodnetwork.com'],
    search: { base: 'https://www.foodnetwork.com/search' },
  },
  {
    stored: 'Fox',
    display: 'Fox',
    aliases: [],
    domains: ['fox.com'],
    search: { base: 'https://www.fox.com/search' },
  },
  {
    stored: 'BritBox',
    display: 'BritBox (British TV from the BBC and ITV)',
    aliases: ['Brit Box'],
    domains: ['britbox.com', 'britbox.co.uk'],
    search: { base: 'https://www.britbox.com/us/search' },
  },
  {
    // Stored as the bare broadcaster name rather than "PBS Passport": most of
    // what members watch here is free on pbs.org, and Passport is a membership
    // tier on top of the same catalogue, not a separate service. Masterpiece
    // is a PBS strand, so it folds in the way FX folds into Hulu.
    stored: 'PBS',
    display: 'PBS (including PBS Passport, Masterpiece, PBS Kids)',
    aliases: ['PBS Passport', 'PBS Kids', 'PBS Masterpiece', 'Masterpiece', 'Masterpiece Theatre'],
    domains: ['pbs.org', 'pbskids.org'],
    search: { base: 'https://www.pbs.org/search/', param: 'q' },
  },
  {
    stored: 'YouTube',
    display: 'YouTube',
    aliases: ['YouTube Premium'],
    domains: ['youtube.com', 'youtu.be'],
    search: { base: 'https://www.youtube.com/results', param: 'search_query' },
  },
  {
    stored: 'MGM+',
    display: 'MGM+',
    aliases: ['MGM', 'MGM Plus'],
    domains: ['mgmplus.com'],
    search: { base: 'https://www.mgmplus.com/search', param: 'q' },
  },

  // --- Storefronts (kind: 'storefront') ---
  // Rent/buy shops, not subscriptions. A title here costs money per view, so
  // it is never a reason to keep or start a monthly service and the
  // Subscription Audit skips it entirely (see isStorefront). They still earn a
  // place in the list: they carry the long tail nothing streams — catalog
  // films, and new releases in the window between theatres and streaming.
  {
    // Stored as "Apple TV Store", not "Apple TV": the bare name is already an
    // alias of Apple TV+ above, and reusing it would silently re-point every
    // member who types "Apple TV" meaning the subscription. Members see the
    // friendlier `display` either way.
    stored: 'Apple TV Store',
    display: 'Apple TV (rent or buy)',
    aliases: ['iTunes', 'iTunes Store', 'Apple TV Rental'],
    // No domains: tv.apple.com is claimed by Apple TV+ above, and one host
    // can't decide between them — the same URL shape serves an Apple original
    // and a $3.99 rental. Which one a row belongs to comes from TMDB's
    // flatrate-vs-rent/buy split, not from the link.
    domains: [],
    search: { base: 'https://tv.apple.com/us/search', param: 'term' },
    kind: 'storefront',
  },
  {
    stored: 'Fandango at Home',
    display: 'Fandango at Home (rent or buy)',
    // No bare 'Fandango' alias — that name belongs to the ticket site below,
    // and letting one entry claim it would repeat the Apple TV / Apple TV+
    // collision.
    aliases: ['Vudu', 'FandangoNow'],
    domains: ['athome.fandango.com', 'vudu.com'],
    search: { base: 'https://athome.fandango.com/content/browse/search', param: 'q' },
    kind: 'storefront',
  },
  {
    // Theatre tickets, for a film still in its theatrical window — the gap
    // where a title is real, members want it on a list, and no streaming
    // service carries it yet. Distinct from Fandango at Home, which is the
    // rent/buy shop for titles that have left theatres.
    stored: 'Fandango',
    display: 'Fandango (theatre tickets)',
    aliases: ['Fandango Tickets', 'In theatres', 'In theaters'],
    domains: ['fandango.com'],
    search: { base: 'https://www.fandango.com/search', param: 'q' },
    kind: 'storefront',
  },
];

// Storefronts are rent/buy shops rather than monthly services. Everything
// without an explicit kind is a subscription.
export function isStorefront(network) {
  const stored = canonicalNetwork(network);
  const hit = NETWORKS.find(n => n.stored === stored);
  return hit ? hit.kind === 'storefront' : false;
}

// TMDB provider names as they appear in a title's `rent` / `buy` arrays,
// mapped to the storefront that sells it.
//
// This deliberately does NOT go through knownNetwork(). TMDB calls its Apple
// rent/buy provider "Apple TV", which the alias index folds into "Apple TV+"
// — the subscription. That single collision is how a $3.99 rental of a 1995
// costume drama ended up labeled as an Apple TV+ original and counted toward
// what a member supposedly needs to pay Apple every month. Rent/buy provider
// names resolve here instead, and only here.
const STOREFRONT_PROVIDERS = new Map([
  ['apple tv', 'Apple TV Store'],
  ['apple itunes', 'Apple TV Store'],
  ['itunes', 'Apple TV Store'],
  ['fandango at home', 'Fandango at Home'],
  ['vudu', 'Fandango at Home'],
]);

export function storefrontFromProvider(name) {
  if (!name) return null;
  return STOREFRONT_PROVIDERS.get(name.trim().toLowerCase()) || null;
}

// Which storefront a stored link points at. Separate from networkFromUrl()
// because tv.apple.com resolves to the Apple TV+ *subscription* there by
// design; here the same host means the Apple storefront. Used to keep a
// reclassified row's label agreeing with the link already sitting on it.
// Most specific host wins, so athome.fandango.com beats fandango.com.
const STOREFRONT_DOMAINS = new Map([
  ['tv.apple.com', 'Apple TV Store'],
  ['apple.co', 'Apple TV Store'],
  ['athome.fandango.com', 'Fandango at Home'],
  ['vudu.com', 'Fandango at Home'],
  ['fandango.com', 'Fandango'],
]);

export function storefrontFromUrl(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  let candidate = host;
  while (candidate.includes('.')) {
    const hit = STOREFRONT_DOMAINS.get(candidate);
    if (hit) return hit;
    candidate = candidate.substring(candidate.indexOf('.') + 1);
  }
  return null;
}

// Map alias-or-stored name (case-insensitive) to canonical stored value.
const _aliasIndex = (() => {
  const m = new Map();
  for (const n of NETWORKS) {
    m.set(n.stored.toLowerCase(), n.stored);
    for (const a of n.aliases) m.set(a.toLowerCase(), n.stored);
  }
  return m;
})();

// Map domain → canonical stored value. Exact host match or *.domain suffix.
const _domainIndex = (() => {
  const m = new Map();
  for (const n of NETWORKS) {
    for (const d of n.domains || []) m.set(d.toLowerCase(), n.stored);
  }
  return m;
})();

export function canonicalNetwork(name) {
  if (!name) return null;
  return _aliasIndex.get(name.trim().toLowerCase()) || name;
}

// Like canonicalNetwork, but returns null for names we don't recognize
// (canonicalNetwork echoes its input). Used to map a TMDB/Watchmode provider
// string to one of our services only when it's genuinely one of them — so a
// variant we don't alias (e.g. "Amazon Prime Video with Ads") is skipped
// rather than stored as a bogus network.
export function knownNetwork(name) {
  if (!name) return null;
  return _aliasIndex.get(name.trim().toLowerCase()) || null;
}

// Given a URL (deep link or search-page), returns the canonical network
// based on its domain — or null if the domain isn't one of ours. Used to
// auto-correct the stored network when a pasted URL disagrees with the
// dropdown pick. URL is authoritative because copy-paste catches the
// real platform; the dropdown is just user judgement.
export function networkFromUrl(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  if (!host) return null;
  // Exact match first; then progressively strip subdomains.
  let candidate = host;
  while (candidate.includes('.')) {
    const hit = _domainIndex.get(candidate);
    if (hit) return hit;
    candidate = candidate.substring(candidate.indexOf('.') + 1);
  }
  return null;
}

export const NETWORK_SEARCH = Object.fromEntries(
  NETWORKS.map(n => [n.stored, n.search])
);

// The service's own search page for a title — the fallback a row gets when
// nobody has pasted a real deep link and Watchmode hasn't resolved one yet.
// These come back with `/search`, `?q=` and friends in them, which is exactly
// the placeholder shape the frontend, sync-urls and the calendar feed treat as
// "no URL". Returns null for a service we have no search template for.
export function networkSearchUrl(network, title) {
  if (!network) return null;
  const cfg = NETWORK_SEARCH[network];
  if (!cfg) return null;
  if (!cfg.param) return cfg.base;
  const params = new URLSearchParams();
  if (cfg.extra) cfg.extra.split('&').forEach(p => { const [k, v] = p.split('='); params.set(k, v); });
  params.set(cfg.param, title);
  return cfg.base + '?' + params.toString();
}

// Editable default monthly prices (US, cents) for the Subscription Audit, so
// the "save $X/mo" figures are real without forcing data entry. These are
// approximate standard-plan rates and drift over time — every member can
// override their own price per service, and these are only the starting point.
// Keyed by canonical `stored` network name.
export const DEFAULT_PRICE_CENTS = {
  'Netflix': 1799,
  'HBO Max': 1699,
  'Apple TV+': 999,
  'Hulu': 999,
  'Paramount+': 799,
  'Peacock': 799,
  'Amazon Prime Video': 899,
  'Disney+': 999,
  'Starz': 1099,
  'AMC+': 899,
  'Food Network': 699,
  'Fox': 799,
  'BritBox': 899,
  'MGM+': 899,
  // PBS Passport, the $60/year member benefit, at its monthly equivalent. Much
  // of PBS streams free without it, so this is the one default a member is
  // likeliest to zero out.
  'PBS': 500,
};

export function defaultPriceCents(network) {
  if (!network) return null;
  const hit = DEFAULT_PRICE_CENTS[canonicalNetwork(network)];
  return hit == null ? null : hit;
}
