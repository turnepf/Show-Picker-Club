// Which of a member's rows belong in "Rate my backlog" — shared by
// /api/rate-backlog (the page) and /api/rate-backlog-count (its nav badge),
// because a badge that disagrees with the page it links to is worse than no
// badge.
//
// Every show off Next Up with a tmdb_id, archived ones included. Archived was
// left out once ("tried including it, cut it after actually using the flow"),
// and came back when Favorite Actors started counting archived shows rated 8
// or higher: an archived show can now matter to a member's taste, so the page
// Favorite Actors sends people to has to be able to rate it.
//
// One row per title. Ratings key off (tmdb_id, tmdb_type), so rating any copy
// rates them all; listing an archived copy next to the live one would ask the
// same question twice. The live copy wins, then the oldest row.
//
// Bind the member slug once, as ?1.
export const BACKLOG_ELIGIBLE_WHERE = `
  s.member_slug = ?1 AND s.list != 'next' AND s.tmdb_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM shows_v o
     WHERE o.member_slug = s.member_slug
       AND o.tmdb_id = s.tmdb_id AND o.tmdb_type IS s.tmdb_type
       AND o.list != 'next'
       AND (o.archived < s.archived OR (o.archived = s.archived AND o.id < s.id))
  )`;

// No overall rating from this member yet (season ratings don't count — the
// backlog is overall-only by design).
export const BACKLOG_UNRATED_WHERE = `
  NOT EXISTS (
    SELECT 1 FROM show_ratings r
     WHERE r.tmdb_id = s.tmdb_id AND r.tmdb_type = s.tmdb_type
       AND r.season_number = 0 AND r.member_slug = s.member_slug
  )`;
