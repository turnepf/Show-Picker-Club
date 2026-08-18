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
// region:    which section of a client's picker this belongs in. Omitted
//            means 'us', the unlabelled first group. See networkCatalog()
//            at the bottom — the apps read their picker from that, over the
//            wire, so adding an entry here reaches installed apps without
//            an App Store release.
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
  {
    // Free and ad-supported, not a subscription tier of Paramount+ — same
    // owner, separate catalogue and separate app — so it gets its own entry
    // rather than folding in as a Paramount+ alias the way CBS and Showtime
    // do. It stays a subscription-kind network (a title here is a reason to
    // open an app you already have, not a per-view purchase); the Subscription
    // Audit just prices it at zero. No `param` on the search base: Pluto's
    // search page takes its query from the box, not the URL.
    stored: 'Pluto TV',
    display: 'Pluto TV (free, ad-supported)',
    aliases: ['Pluto', 'PlutoTV', 'Pluto.tv'],
    domains: ['pluto.tv'],
    search: { base: 'https://pluto.tv/us/search' },
  },

  // --- United Kingdom ---
  // BritBox already sits above: it's the BBC/ITV export service sold in the US,
  // which is a different product from what someone in Britain actually watches.
  // These are the home services, and they exist here for the same reason the US
  // ones do — a member types "on iPlayer" or pastes an itv.com link, and without
  // an entry that lands in the DB as free text nothing can group, price or link.
  //
  // Aliases stay specific enough that a bare English word can't claim a
  // canonical. Channel 4's sub-brands (E4, Film4) are safe; "Five", "Nine" and
  // "Ten" are not, so they're absent even though the broadcasters go by them.
  {
    // 'BBC America' is already an AMC+ alias and stays there — it's a US cable
    // channel that licenses BBC shows, not a way to reach iPlayer.
    stored: 'BBC iPlayer',
    region: 'uk',
    display: 'BBC iPlayer (including BBC One, BBC Two, BBC Three, BBC Four)',
    aliases: ['BBC', 'iPlayer', 'BBC One', 'BBC Two', 'BBC Three', 'BBC Four', 'BBC1', 'BBC2', 'BBC Scotland'],
    domains: ['bbc.co.uk', 'bbc.com'],
    search: { base: 'https://www.bbc.co.uk/iplayer/search', param: 'q' },
  },
  {
    stored: 'ITVX',
    region: 'uk',
    display: 'ITVX (including ITV1, ITV2, ITV3, ITV4, ITVBe)',
    aliases: ['ITV', 'ITV X', 'ITV Hub', 'ITV Player', 'ITV1', 'ITV2', 'ITV3', 'ITV4', 'ITVBe'],
    domains: ['itv.com', 'itvx.com'],
    search: { base: 'https://www.itv.com/search', param: 'q' },
  },
  {
    stored: 'Channel 4',
    region: 'uk',
    display: 'Channel 4 (including E4, More4, Film4)',
    aliases: ['Channel4', 'All 4', 'All4', '4oD', 'E4', 'More4', 'Film4'],
    domains: ['channel4.com'],
    search: { base: 'https://www.channel4.com/search', param: 'q' },
  },
  {
    // Paramount owns Channel 5, but it's a separate app with a separate
    // catalogue — the same reason Pluto TV isn't a Paramount+ alias.
    stored: 'Channel 5',
    region: 'uk',
    display: 'Channel 5 (My5)',
    aliases: ['Channel5', 'My5', 'My 5'],
    domains: ['channel5.com', 'my5.tv'],
    search: { base: 'https://www.channel5.com/search', param: 'q' },
  },
  {
    // Stored as the streaming brand, which is what a title is actually watched
    // on — Sky's channels reach a phone through NOW, and every Sky channel name
    // folds in here rather than becoming its own entry. Displayed with "Sky" in
    // the name because that's what members call it.
    stored: 'NOW',
    region: 'uk',
    display: 'NOW (Sky — Sky Atlantic, Sky Max, Sky Cinema)',
    aliases: ['NOW TV', 'NowTV', 'Now TV', 'Sky', 'Sky Go', 'Sky Atlantic', 'Sky Max', 'Sky One', 'Sky Showcase', 'Sky Cinema', 'Sky Comedy', 'Sky Crime', 'Sky Documentaries'],
    domains: ['nowtv.com', 'sky.com'],
    search: { base: 'https://www.nowtv.com/gb/search', param: 'q' },
  },

  // --- Australia ---
  // Same reasoning as the UK block. The three commercial broadcasters are
  // stored under their streaming names (9Now, 7plus, 10 play) rather than
  // "Channel 9" and friends, so the stored value names something a member can
  // open; the channel names are aliases.
  {
    stored: 'Stan',
    region: 'au',
    display: 'Stan',
    aliases: [],
    domains: ['stan.com.au'],
    search: { base: 'https://www.stan.com.au/search', param: 'q' },
  },
  {
    stored: 'Binge',
    region: 'au',
    display: 'Binge',
    aliases: [],
    domains: ['binge.com.au'],
    search: { base: 'https://binge.com.au/search', param: 'q' },
  },
  {
    stored: 'Foxtel',
    region: 'au',
    display: 'Foxtel (including Foxtel Now)',
    // Binge is Foxtel-owned but priced and subscribed to separately, so it
    // stays its own entry above rather than folding in here.
    aliases: ['Foxtel Now', 'Foxtel Go', 'Foxtel Play'],
    domains: ['foxtel.com.au'],
    search: { base: 'https://www.foxtel.com.au/search', param: 'q' },
  },
  {
    // Never aliased as bare 'ABC' — that belongs to the US network, which folds
    // into Hulu. TMDB writes the Australian one as "ABC (AU)".
    stored: 'ABC iview',
    region: 'au',
    display: 'ABC iview (Australia)',
    aliases: ['iview', 'ABC iView', 'ABC (AU)', 'ABC Australia', 'ABC TV (Australia)'],
    domains: ['iview.abc.net.au', 'abc.net.au'],
    search: { base: 'https://iview.abc.net.au/search', param: 'keyword' },
  },
  {
    stored: 'SBS On Demand',
    region: 'au',
    display: 'SBS On Demand (including NITV, SBS World Movies)',
    aliases: ['SBS', 'SBS on Demand', 'SBS Viceland', 'SBS World Movies', 'NITV'],
    domains: ['sbs.com.au'],
    search: { base: 'https://www.sbs.com.au/ondemand/search', param: 'q' },
  },
  {
    stored: '9Now',
    region: 'au',
    display: '9Now (Nine Network)',
    aliases: ['Nine Network', 'Channel 9', 'Channel Nine', '9Go!', '9Gem', '9Life'],
    domains: ['9now.com.au', 'nine.com.au'],
    search: { base: 'https://www.9now.com.au/search', param: 'q' },
  },
  {
    stored: '7plus',
    region: 'au',
    display: '7plus (Seven Network)',
    aliases: ['7 plus', 'Seven Network', 'Channel 7', 'Channel Seven', '7two', '7mate', '7flix'],
    domains: ['7plus.com.au', 'seven.com.au'],
    search: { base: 'https://7plus.com.au/search', param: 'q' },
  },
  {
    stored: '10 play',
    region: 'au',
    display: '10 play (Network 10)',
    aliases: ['10play', '10 Play', 'Network 10', 'Network Ten', 'Channel 10', 'Channel Ten', '10 Peach', '10 Bold'],
    domains: ['10play.com.au'],
    search: { base: 'https://10play.com.au/search', param: 'q' },
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

// --- The catalog clients read ---
//
// The apps used to carry their own copy of this list, which meant a network
// added here reached a member only when they installed a new build from the
// App Store — weeks later, and never for anyone who doesn't update. They now
// fetch `networkCatalog()` from GET /api/networks, so adding an entry above is
// the whole change.
//
// Picker sections are built here rather than by each client: a client groups
// consecutive entries by the `section` string it is handed and renders that
// string as the header, so a region added later needs no app release either.
// Regions are emitted in this order, storefronts last regardless of where they
// sit in NETWORKS — grouping can't depend on somebody keeping the array tidy.
// Within a section the rows are sorted alphabetically, for the same reason:
// where an entry sits in the NETWORKS array decides nothing a member sees, so
// a new service can be appended wherever it reads best in the source.
const REGION_SECTIONS = [
  // `null` is the unlabelled first group: the services most of the club uses,
  // which shouldn't wear a "United States" header nobody needs.
  { region: 'us', section: null },
  { region: 'uk', section: 'United Kingdom' },
  { region: 'au', section: 'Australia' },
];

const STOREFRONT_SECTION = 'Rent or buy';

// Alphabetical, case-insensitively: "Amazon Prime Video" comes before "AMC+"
// rather than after it, which is where a raw codepoint sort ('M' < 'm') puts
// it and not where anyone looks for it. Sorted on `display`, the label the web
// <select> draws; the iOS menu draws `stored`, and every display string starts
// with its stored name except "Apple TV Store" (whose storefront neighbours
// sort the same either way), so both surfaces read alphabetically. The tie
// break on `stored` keeps the order — and the version hashed from it — stable.
function byLabel(a, b) {
  const al = a.display.toLowerCase(), bl = b.display.toLowerCase();
  if (al !== bl) return al < bl ? -1 : 1;
  return a.stored < b.stored ? -1 : a.stored > b.stored ? 1 : 0;
}

export function networkCatalog() {
  const subscriptions = NETWORKS.filter(n => n.kind !== 'storefront');
  const networks = [];
  const row = (n, section, storefront) =>
    ({ stored: n.stored, display: n.display, section, storefront });
  for (const { region, section } of REGION_SECTIONS) {
    networks.push(...subscriptions
      .filter(n => (n.region || 'us') === region)
      .map(n => row(n, section, false))
      .sort(byLabel));
  }
  // A region added to an entry but not to REGION_SECTIONS would otherwise
  // vanish from every picker silently. Emit it under its own raw key instead —
  // ugly beats missing, and networks-test.mjs fails on it. Sorted by section
  // first so each stray region still arrives as one consecutive run.
  networks.push(...subscriptions
    .filter(n => !networks.some(x => x.stored === n.stored))
    .map(n => row(n, n.region, false))
    .sort((a, b) => (a.section < b.section ? -1 : a.section > b.section ? 1 : byLabel(a, b))));
  networks.push(...NETWORKS
    .filter(n => n.kind === 'storefront')
    .map(n => row(n, STOREFRONT_SECTION, true))
    .sort(byLabel));
  return { version: catalogVersion(networks), networks };
}

// Cheap content hash (FNV-1a) over what a client actually renders, so a client
// can tell "same list as last time" without diffing, and so a stale cache is
// identifiable in a bug report. Not a security boundary — the payload is
// public — just a version string that changes when the list does.
function catalogVersion(networks) {
  const text = networks.map(n => `${n.stored}|${n.display}|${n.section || ''}|${n.storefront}`).join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${networks.length}-${h.toString(16)}`;
}

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
  // Free, ad-supported: zero rather than absent, so the audit says "$0/mo"
  // because we know it costs nothing, not because nobody has priced it yet.
  // A cancel verdict on Pluto TV saves exactly nothing, and the totals show it.
  'Pluto TV': 0,
  // PBS Passport, the $60/year member benefit, at its monthly equivalent. Much
  // of PBS streams free without it, so this is the one default a member is
  // likeliest to zero out.
  'PBS': 500,

  // Free-to-air catch-up, UK and Australia. Zero for the same reason Pluto TV
  // is zero — we know these cost nothing rather than nobody having priced them
  // — and zero is the one figure that survives being quoted in US cents.
  // ITVX, Channel 4 and My5 sell optional ad-free tiers; the default is the
  // free tier everyone actually uses. BBC iPlayer is funded by the TV licence,
  // which is a household bill nobody cancels from a show tracker.
  'BBC iPlayer': 0,
  'ITVX': 0,
  'Channel 4': 0,
  'Channel 5': 0,
  'ABC iview': 0,
  'SBS On Demand': 0,
  '9Now': 0,
  '7plus': 0,
  '10 play': 0,
  // Deliberately absent: NOW, Stan, Binge, Foxtel. They're paid, but they're
  // billed in pounds and Australian dollars, and this table is US cents that
  // the Subscription Audit sums into one total. A converted guess would be
  // wrong twice over — wrong rate, wrong currency in the sum — so these arrive
  // unpriced and the member enters what they actually pay.
};

export function defaultPriceCents(network) {
  if (!network) return null;
  const hit = DEFAULT_PRICE_CENTS[canonicalNetwork(network)];
  return hit == null ? null : hit;
}
