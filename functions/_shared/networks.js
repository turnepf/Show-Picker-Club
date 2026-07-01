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
    display: 'Amazon Prime Video (including MGM+, Freevee)',
    aliases: ['Amazon', 'Amazon Prime', 'Prime Video', 'MGM+', 'MGM', 'Freevee', 'IMDb TV'],
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
    stored: 'YouTube',
    display: 'YouTube',
    aliases: ['YouTube Premium'],
    domains: ['youtube.com', 'youtu.be'],
    search: { base: 'https://www.youtube.com/results', param: 'search_query' },
  },
];

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
};

export function defaultPriceCents(network) {
  if (!network) return null;
  const hit = DEFAULT_PRICE_CENTS[canonicalNetwork(network)];
  return hit == null ? null : hit;
}
