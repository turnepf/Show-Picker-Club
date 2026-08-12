// Members excluded from taste-based features (Recommendations, Vibe,
// trait scoring). Their lists are too sprawling and accumulate too many
// shows to represent real taste — including them would dilute every signal.
// They can still use the app normally; the exclusion only applies when other
// features read their list to compute something.
//
// "Other features" is the whole of it: an excluded member still reads their
// own vibe (`/api/vibe` carves the viewer out of this list for their own
// slug), because that is them looking at their own library, not the club
// averaging them in. What stays excluded is every club-level signal —
// Trending, the recommendation neighbour pool, other members' vibe pickers,
// and the aligned-picks candidate pool.
export const EXCLUDED_FROM_TASTE = ['paula'];
