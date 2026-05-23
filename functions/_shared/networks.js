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
// searchUrl: fallback URL used when the user picks a network but doesn't
//            paste a deep link. Twilio-style: optional { param } means the
//            title gets appended as a query param; bare bases just open the
//            network's search page with the title typed in.

export const NETWORKS = [
  {
    stored: 'Netflix',
    display: 'Netflix',
    aliases: [],
    search: { base: 'https://www.netflix.com/search' },
  },
  {
    stored: 'Max',
    display: 'Max (including HBO, Discovery, Cartoon Network, Adult Swim, TNT, TBS, truTV, CNN)',
    aliases: ['HBO', 'HBO Max', 'Discovery', 'Discovery+', 'Cartoon Network', 'Adult Swim', 'TNT', 'TBS', 'truTV', 'CNN'],
    search: { base: 'https://play.max.com/search', param: 'q' },
  },
  {
    stored: 'Apple TV+',
    display: 'Apple TV+',
    aliases: ['Apple TV', 'AppleTV+', 'AppleTV'],
    search: { base: 'https://tv.apple.com/search', param: 'term' },
  },
  {
    stored: 'Hulu',
    display: 'Hulu (including FX, FXX, ABC, National Geographic, Freeform)',
    aliases: ['FX', 'FXX', 'ABC', 'National Geographic', 'Nat Geo', 'Freeform'],
    search: { base: 'https://www.hulu.com/search' },
  },
  {
    stored: 'Paramount+',
    display: 'Paramount+ (including CBS, MTV, Comedy Central, Nickelodeon, BET, Showtime)',
    aliases: ['Paramount', 'CBS', 'MTV', 'Comedy Central', 'Nickelodeon', 'BET', 'Showtime', 'Smithsonian Channel'],
    search: { base: 'https://www.paramountplus.com/search' },
  },
  {
    stored: 'Peacock',
    display: 'Peacock (including NBC, Bravo, USA, Syfy, Oxygen, E!)',
    aliases: ['NBC', 'Bravo', 'USA', 'USA Network', 'Syfy', 'SyFy', 'Oxygen', 'E!'],
    search: { base: 'https://www.peacocktv.com/watch/search' },
  },
  {
    stored: 'Amazon Prime Video',
    display: 'Amazon Prime Video (including MGM+, Freevee)',
    aliases: ['Amazon', 'Amazon Prime', 'Prime Video', 'MGM+', 'MGM', 'Freevee', 'IMDb TV'],
    search: { base: 'https://www.amazon.com/s', param: 'k', extra: 'i=instant-video' },
  },
  {
    stored: 'Disney+',
    display: 'Disney+ (including Marvel, Star Wars, Pixar, National Geographic)',
    aliases: ['Disney', 'Marvel', 'Star Wars', 'Pixar'],
    search: { base: 'https://www.disneyplus.com/browse/search' },
  },
  {
    stored: 'Starz',
    display: 'Starz',
    aliases: [],
    search: { base: 'https://www.starz.com/search', param: 'q' },
  },
  {
    stored: 'AMC+',
    display: 'AMC+ (including AMC, BBC America, IFC, Sundance, Shudder)',
    aliases: ['AMC', 'BBC America', 'IFC', 'Sundance', 'Shudder'],
    search: { base: 'https://www.amcplus.com/search', param: 'q' },
  },
  {
    stored: 'Food Network',
    display: 'Food Network',
    aliases: [],
    search: { base: 'https://www.foodnetwork.com/search' },
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

export function canonicalNetwork(name) {
  if (!name) return null;
  return _aliasIndex.get(name.trim().toLowerCase()) || name;
}

export const NETWORK_SEARCH = Object.fromEntries(
  NETWORKS.map(n => [n.stored, n.search])
);
