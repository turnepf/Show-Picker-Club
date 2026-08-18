// Which lists count as "the club is picking this up right now".
//
// Watching, Awaiting and Loved are all statements of intent — someone is
// watching it, waiting for it, or loved it. Next Up is not: it's the maybe-pile,
// and counting it let a title nobody had started trend on the strength of
// people bookmarking it. Both Trending queries (club-wide and per-group) share
// this so the two can't drift apart on what "trending" means.
//
// Sarah reported it against Group Trending, where a small member set makes one
// person's bookmarks visibly move the ranking. Neither query had ever filtered
// on list, so the club-wide one had the same bug, less legibly.
//
// These are the stored list keys; ShowPickerCore.ShowList maps them to the
// display names Watching / Awaiting / Loved / Next Up.
export const TRENDING_LISTS = ['watching', 'waiting', 'recommending'];

export const TRENDING_LISTS_SQL = TRENDING_LISTS.map(l => `'${l}'`).join(',');
