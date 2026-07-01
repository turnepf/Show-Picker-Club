import Foundation

// Shared JSON shapes returned by showpicker.club. This is the superset used by
// every Apple client; each app layers its own platform-specific types (offline
// queue, cross-library search rows, iTunes lookups) on top.

public struct Actor: Codable, Hashable, Sendable {
    public let name: String
    public let imdbId: String?

    public init(name: String, imdbId: String? = nil) {
        self.name = name
        self.imdbId = imdbId
    }

    enum CodingKeys: String, CodingKey {
        case name
        case imdbId = "imdb_id"
    }
}

public struct Show: Codable, Identifiable, Hashable, Sendable {
    public let id: Int
    public let title: String
    public let network: String?
    public let networkUrl: String?
    public let recommendedBy: String?
    public let rating: String?
    public let list: String
    public let notes: String?
    public let movie: Int?
    public let fullSeries: Int?
    public let watchingWith: String?
    public let nextSeasonDate: String?
    public let seasonEndDate: String?
    public let seasonsReleased: Int?
    public let genres: String?
    public let memberSlug: String?
    public let posterUrl: String?
    public let networkLogoUrl: String?
    public let createdAt: String?
    public let archived: Int?
    // The API returns actors as a JSON-encoded string (from SQLite's
    // json_group_array). Decoded lazily via `castMembers`.
    public let actors: String?

    // Explicit public init so other modules (the apps, their offline queues)
    // can construct a Show — the synthesized memberwise init is internal.
    // Parameter order matches the fields as they were declared in the apps'
    // old local model, so positional-ish call sites (the iOS offline queue)
    // keep compiling; the tvOS-only networkLogoUrl is appended last.
    public init(
        id: Int,
        title: String,
        network: String? = nil,
        networkUrl: String? = nil,
        recommendedBy: String? = nil,
        rating: String? = nil,
        list: String,
        notes: String? = nil,
        movie: Int? = nil,
        fullSeries: Int? = nil,
        watchingWith: String? = nil,
        nextSeasonDate: String? = nil,
        seasonEndDate: String? = nil,
        seasonsReleased: Int? = nil,
        genres: String? = nil,
        actors: String? = nil,
        archived: Int? = nil,
        memberSlug: String? = nil,
        createdAt: String? = nil,
        posterUrl: String? = nil,
        networkLogoUrl: String? = nil
    ) {
        self.id = id
        self.title = title
        self.list = list
        self.network = network
        self.networkUrl = networkUrl
        self.recommendedBy = recommendedBy
        self.rating = rating
        self.notes = notes
        self.movie = movie
        self.fullSeries = fullSeries
        self.watchingWith = watchingWith
        self.nextSeasonDate = nextSeasonDate
        self.seasonEndDate = seasonEndDate
        self.seasonsReleased = seasonsReleased
        self.genres = genres
        self.memberSlug = memberSlug
        self.posterUrl = posterUrl
        self.networkLogoUrl = networkLogoUrl
        self.createdAt = createdAt
        self.archived = archived
        self.actors = actors
    }

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, list, notes, movie, genres, actors, archived
        case networkUrl = "network_url"
        case recommendedBy = "recommended_by"
        case fullSeries = "full_series"
        case watchingWith = "watching_with"
        case nextSeasonDate = "next_season_date"
        case seasonEndDate = "season_end_date"
        case seasonsReleased = "seasons_released"
        case memberSlug = "member_slug"
        case posterUrl = "poster_url"
        case networkLogoUrl = "network_logo_url"
        case createdAt = "created_at"
    }

    public var isMovie: Bool { (movie ?? 0) == 1 }
    public var isFullSeries: Bool { (fullSeries ?? 0) == 1 }
    public var isArchived: Bool { (archived ?? 0) == 1 }

    public var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    // "3 seasons" / "1 season" — total seasons released, when known.
    public var seasonsText: String? {
        guard let n = seasonsReleased, n > 0 else { return nil }
        return "\(n) season\(n == 1 ? "" : "s")"
    }

    // Format an ISO "YYYY-MM-DD" as "M/D", matching the web's formatDate.
    private func monthDay(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        let p = s.split(separator: "-")
        guard p.count >= 3, let m = Int(p[1]), let d = Int(p[2]) else { return s }
        return "\(m)/\(d)"
    }

    // Premiere of the next season ("6/1" or "6/1 – 6/30"); nil without a
    // premiere date. Used on the Watching/Awaiting list rows.
    public var nextUpRange: String? {
        guard let start = monthDay(nextSeasonDate) else { return nil }
        if let end = monthDay(seasonEndDate), end != start { return "\(start) – \(end)" }
        return start
    }

    // Whatever season dates exist, for the detail view (falls back to a
    // finale-only "through M/D").
    public var seasonDatesText: String? {
        if let r = nextUpRange { return r }
        if let end = monthDay(seasonEndDate) { return "through \(end)" }
        return nil
    }

    public var castMembers: [Actor] {
        guard let actors, let data = actors.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([Actor].self, from: data)) ?? []
    }

    // A real deep link (not a search-page placeholder). HBO Max search URLs are
    // an intentional fallback we still allow through.
    public var hasRealUrl: Bool {
        guard let u = networkUrl?.lowercased() else { return false }
        if u.isEmpty || u == "#" { return false }
        if u.hasPrefix("https://play.hbomax.com/search?") { return true }
        if u.hasPrefix("https://play.hbomax.com/search/result?") { return true }
        return !(u.contains("/search") || u.contains("/s?") || u.contains("?q=") || u.contains("?query="))
    }

    public var isHBOMaxSearchFallback: Bool {
        guard let u = networkUrl?.lowercased() else { return false }
        return u.hasPrefix("https://play.hbomax.com/search?")
            || u.hasPrefix("https://play.hbomax.com/search/result?")
    }
}

public struct ShowsResponse: Codable, Sendable { public let shows: [Show] }
public struct ShowResponse: Codable, Sendable { public let show: Show }
public struct ActorsResponse: Codable, Sendable { public let actors: [Actor] }
