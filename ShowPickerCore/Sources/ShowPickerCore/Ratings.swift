import Foundation

// Average + count for one season. The same shape also carries the overall
// rating, as RatingsSummary.average/count. Mirrors
// functions/_shared/ratings.js#getRatingsSummary.
public struct SeasonRatingSummary: Codable, Hashable, Sendable {
    public let average: Double?
    public let count: Int

    public init(average: Double? = nil, count: Int = 0) {
        self.average = average
        self.count = count
    }

    enum CodingKeys: String, CodingKey {
        case average, count
    }
}

// Ratings for one title, keyed server-side by tmdb_id/tmdb_type rather than
// any one member's row (migration 053) — every member's independent copy of
// the same show shares this one summary. `average`/`count` are the whole
// club's overall rating and show on every card, logged in or not. `mine` is
// the viewing member's own overall rating; `mineSeasons` keys by season
// number (matching `Show.seasonsReleased`'s numbering). `owner`/
// `ownerSeasons`/`ownerName` populate only when viewing a specific OTHER
// member's copy of the show — never your own, since there's nothing extra
// to say when the owner is the viewer.
public struct RatingsSummary: Codable, Hashable, Sendable {
    public let average: Double?
    public let count: Int
    public let seasons: [Int: SeasonRatingSummary]
    public let mine: Int?
    public let mineSeasons: [Int: Int]
    public let owner: Int?
    public let ownerSeasons: [Int: Int]
    public let ownerName: String?

    public init(
        average: Double? = nil,
        count: Int = 0,
        seasons: [Int: SeasonRatingSummary] = [:],
        mine: Int? = nil,
        mineSeasons: [Int: Int] = [:],
        owner: Int? = nil,
        ownerSeasons: [Int: Int] = [:],
        ownerName: String? = nil
    ) {
        self.average = average
        self.count = count
        self.seasons = seasons
        self.mine = mine
        self.mineSeasons = mineSeasons
        self.owner = owner
        self.ownerSeasons = ownerSeasons
        self.ownerName = ownerName
    }

    enum CodingKeys: String, CodingKey {
        case average, count, seasons, mine, mineSeasons, owner, ownerSeasons, ownerName
    }

    // Copy-with helpers for optimistic local updates — e.g. when a rating
    // was queued offline and there's no freshly-recomputed summary back
    // from the server yet, fold the tapped value in locally so the UI
    // reflects it immediately.
    public func withMine(_ value: Int) -> RatingsSummary {
        RatingsSummary(average: average, count: count, seasons: seasons, mine: value,
                       mineSeasons: mineSeasons, owner: owner, ownerSeasons: ownerSeasons,
                       ownerName: ownerName)
    }

    public func withMineSeason(_ season: Int, value: Int) -> RatingsSummary {
        var s = mineSeasons
        s[season] = value
        return RatingsSummary(average: average, count: count, seasons: seasons, mine: mine,
                              mineSeasons: s, owner: owner, ownerSeasons: ownerSeasons,
                              ownerName: ownerName)
    }
}

// Response from PUT /api/shows/:id/rating.
public struct RatingResponse: Codable, Sendable {
    public let ok: Bool
    public let ratings: RatingsSummary?
}

// One row in the "rate your backlog" bulk flow (GET /api/rate-backlog) — a
// show the member hasn't given an overall rating yet. Mirrors
// functions/api/rate-backlog.js.
public struct RateBacklogShow: Codable, Identifiable, Sendable {
    public let id: Int
    public let title: String
    public let posterUrl: String?
    public let movie: Int?
    public let list: String
    public let seasonsReleased: Int?
    // The backlog lists archived shows too. Optional so a payload from before
    // that still decodes.
    public let archived: Int?

    public var isMovie: Bool { (movie ?? 0) == 1 }
    public var isArchived: Bool { (archived ?? 0) == 1 }

    enum CodingKeys: String, CodingKey {
        case id, title, list, movie, archived
        case posterUrl = "poster_url"
        case seasonsReleased = "seasons_released"
    }
}

public struct RateBacklogResponse: Codable, Sendable {
    public let shows: [RateBacklogShow]
    public let hasAny: Bool

    enum CodingKeys: String, CodingKey {
        case shows
        case hasAny = "has_any"
    }
}

// GET /api/rate-backlog-count — the unrated count on its own, for the
// "Rate my backlog" nav badge.
public struct RateBacklogCountResponse: Codable, Sendable {
    public let count: Int
}
