import Foundation

/// "Is this the same show?" — the app's one rule, matching the server's
/// (functions/_shared/same-show.js).
///
/// A TMDB entry is a show's identity. Two shows are the same when both carry
/// the same entry; the title decides only when one side was never matched.
/// Three 2026 films are called "The Odyssey", so owning one must not hide
/// the others in search or make their show page read "on your list".
/// Movie-ness is part of the match either way: owning Fargo the series
/// doesn't make Fargo the film yours.
public enum ShowIdentity {
    public static func same(
        title a: String, isMovie aIsMovie: Bool, tmdbId aId: Int?,
        title b: String, isMovie bIsMovie: Bool, tmdbId bId: Int?
    ) -> Bool {
        guard aIsMovie == bIsMovie else { return false }
        if let aId, let bId { return aId == bId }
        return a.lowercased() == b.lowercased()
    }
}

public extension Show {
    /// Whether `other` is a copy of this same show (see `ShowIdentity`).
    func isSameShow(as other: Show) -> Bool {
        ShowIdentity.same(title: title, isMovie: isMovie, tmdbId: tmdbId,
                          title: other.title, isMovie: other.isMovie, tmdbId: other.tmdbId)
    }
}
