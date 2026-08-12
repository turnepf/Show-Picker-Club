// Members excluded from taste-based features (Recommendations, Vibe,
// trait scoring). Their lists are too sprawling and accumulate too many
// shows to represent real taste — including them would dilute every signal.
// They can still use the app normally; the exclusion only applies when other
// features read their list to compute something.
//
// "Compute something" is the whole of it. This list bounds club-level MATH —
// Trending, the recommendation neighbour pool, the aligned-picks candidate
// pool. It is not a visibility rule and must never be read as one: an excluded
// member reads their own vibe, and so do the group-mates they chose, exactly
// like everyone else. Using it to decide who may LOOK at a profile made one
// member invisible to her own group while she could see all of them.
export const EXCLUDED_FROM_TASTE = ['paula'];
