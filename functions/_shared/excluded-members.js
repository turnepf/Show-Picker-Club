// Members excluded from taste-based features (Recommendations, Vibe,
// trait scoring). Their lists are too sprawling and accumulate too many
// shows to represent real taste — including them would dilute every signal.
// They can still use the app normally; the exclusion only applies when other
// features read their list to compute something.
export const EXCLUDED_FROM_TASTE = ['paula'];
