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
    // Position within the member's list for the "My order" manual sort.
    // `var` so the apps can restamp positions locally after a drag without
    // waiting for a refetch. NULL/nil = never manually placed.
    public var sortOrder: Int?
    // The API returns actors as a JSON-encoded string (from SQLite's
    // json_group_array). Decoded lazily via `castMembers`.
    public let actors: String?
    // Richer TMDB detail fields (all optional; backfilled by enrichment).
    public let overview: String?
    public let backdropUrl: String?
    public let tmdbRating: String?      // TMDB audience score "x.y"; mirrors `rating` now (kept for older builds)
    public let contentRating: String?   // US maturity certification (TV-MA, R, …)
    public let trailerKey: String?      // YouTube video key
    public let director: String?        // director (movie) or creator(s) (TV)
    public let directorImdbId: String?  // IMDB id (nm…) of the creator/director, for the person link
    public let runtime: Int?            // minutes
    public let releaseYear: Int?
    public let watchLink: String?       // fallback "where to watch" page; used only when there's no real deep link

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
        networkLogoUrl: String? = nil,
        sortOrder: Int? = nil,
        overview: String? = nil,
        backdropUrl: String? = nil,
        tmdbRating: String? = nil,
        contentRating: String? = nil,
        trailerKey: String? = nil,
        director: String? = nil,
        runtime: Int? = nil,
        releaseYear: Int? = nil,
        watchLink: String? = nil,
        directorImdbId: String? = nil
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
        self.sortOrder = sortOrder
        self.overview = overview
        self.backdropUrl = backdropUrl
        self.tmdbRating = tmdbRating
        self.contentRating = contentRating
        self.trailerKey = trailerKey
        self.director = director
        self.directorImdbId = directorImdbId
        self.runtime = runtime
        self.releaseYear = releaseYear
        self.watchLink = watchLink
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
        case sortOrder = "sort_order"
        case overview
        case backdropUrl = "backdrop_url"
        case tmdbRating = "tmdb_rating"
        case contentRating = "content_rating"
        case trailerKey = "trailer_key"
        case director
        case directorImdbId = "director_imdb_id"
        case runtime
        case releaseYear = "release_year"
        case watchLink = "watch_link"
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

    // Combined series line for the detail screen: "4 Seasons, Complete" while
    // ended, "2 Seasons" while running, or just "Complete" when the count is
    // unknown. nil when neither a count nor the ended flag is set.
    public var seriesText: String? {
        var parts: [String] = []
        if let n = seasonsReleased, n > 0 { parts.append("\(n) Season\(n == 1 ? "" : "s")") }
        if isFullSeries { parts.append("Complete") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    // Format an ISO "YYYY-MM-DD" as "M/D", matching the web's formatDate.
    private func monthDay(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        let p = s.split(separator: "-")
        guard p.count >= 3, let m = Int(p[1]), let d = Int(p[2]) else { return s }
        return "\(m)/\(d)"
    }

    // Premiere of the next season ("6/1"); nil without a premiere date.
    // Used on the Watching/Awaiting list rows. Deliberately just the one
    // date — the finale date stays off "Next episode" everywhere.
    public var nextUpRange: String? {
        monthDay(nextSeasonDate)
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

    // Minutes → "1h 52m" / "45m".
    public var runtimeText: String? {
        guard let n = runtime, n > 0 else { return nil }
        let h = n / 60, m = n % 60
        if h > 0 { return m > 0 ? "\(h)h \(m)m" : "\(h)h" }
        return "\(m)m"
    }

    // "Director" for a film, "Creator" for a series — matches the field's source.
    public var directorLabel: String { isMovie ? "Director" : "Creator" }

    // IMDB person page for the creator/director — only for a single-person
    // credit (a comma means multiple names, so the one id wouldn't match the
    // whole label). nil otherwise, in which case the name renders as plain text.
    public var directorURL: URL? {
        guard let id = directorImdbId, !id.isEmpty,
              let d = director, !d.contains(",") else { return nil }
        return URL(string: "https://www.imdb.com/name/\(id)/")
    }

    // YouTube trailer URL, when a key is present.
    public var trailerURL: URL? {
        guard let k = trailerKey, !k.isEmpty else { return nil }
        return URL(string: "https://www.youtube.com/watch?v=\(k)")
    }

    // Fallback "where to watch" aggregator page — only when there's no real
    // deep link, mirroring the web's Network-row fallback.
    public var whereToWatchURL: URL? {
        guard !hasRealUrl, let l = watchLink, !l.isEmpty else { return nil }
        return URL(string: l)
    }
}

public struct ShowsResponse: Codable, Sendable { public let shows: [Show] }
// `ratings` is a sibling of `show` in the API response, not nested under it
// (functions/api/shows/[id].js) — nil whenever the show has no tmdb_id yet.
public struct ShowResponse: Codable, Sendable {
    public let show: Show
    public let ratings: RatingsSummary?

    // Explicit public init — the synthesized memberwise init is only
    // internal even though the struct is public, so other modules (the
    // apps' offline-cache fallbacks) couldn't construct one without this.
    public init(show: Show, ratings: RatingsSummary? = nil) {
        self.show = show
        self.ratings = ratings
    }
}
public struct ActorsResponse: Codable, Sendable { public let actors: [Actor] }

public struct Group: Codable, Identifiable, Hashable, Sendable {
    public let id: Int
    public let name: String
    public let creatorSlug: String
    public let createdAt: String
    public let memberCount: Int
    public let isCreator: Bool

    public init(id: Int, name: String, creatorSlug: String, createdAt: String, memberCount: Int = 0, isCreator: Bool = false) {
        self.id = id
        self.name = name
        self.creatorSlug = creatorSlug
        self.createdAt = createdAt
        self.memberCount = memberCount
        self.isCreator = isCreator
    }

    enum CodingKeys: String, CodingKey {
        case id, name, creatorSlug = "creator_slug", createdAt = "created_at"
        case memberCount = "member_count", isCreator = "is_creator"
    }
}

public struct GroupMember: Codable, Identifiable, Hashable, Sendable {
    public let slug: String
    public let firstName: String?
    public let lastName: String?
    public let showCount: Int
    public let watchingCount: Int
    public let awaitingCount: Int
    public let lastActivityAt: String?

    public var id: String { slug }
    public var displayName: String {
        if let first = firstName {
            return first
        }
        return slug
    }

    public init(
        slug: String,
        firstName: String? = nil,
        lastName: String? = nil,
        showCount: Int = 0,
        watchingCount: Int = 0,
        awaitingCount: Int = 0,
        lastActivityAt: String? = nil
    ) {
        self.slug = slug
        self.firstName = firstName
        self.lastName = lastName
        self.showCount = showCount
        self.watchingCount = watchingCount
        self.awaitingCount = awaitingCount
        self.lastActivityAt = lastActivityAt
    }

    enum CodingKeys: String, CodingKey {
        case slug, firstName = "first_name", lastName = "last_name"
        case showCount = "show_count", watchingCount = "watching_count"
        case awaitingCount = "awaiting_count", lastActivityAt = "last_activity_at"
    }
}

public struct GroupDetail: Codable, Sendable {
    public let group: Group
    public let members: [GroupMember]
    public let isCreator: Bool
    public let canManage: Bool

    public init(group: Group, members: [GroupMember], isCreator: Bool = false, canManage: Bool = false) {
        self.group = group
        self.members = members
        self.isCreator = isCreator
        self.canManage = canManage
    }

    enum CodingKeys: String, CodingKey {
        case group, members, isCreator = "is_creator", canManage = "can_manage"
    }
}

public struct GroupInvite: Codable, Sendable {
    public let token: String
    public let expiresAt: String
    public let url: String

    public init(token: String, expiresAt: String, url: String) {
        self.token = token
        self.expiresAt = expiresAt
        self.url = url
    }

    enum CodingKeys: String, CodingKey {
        case token, expiresAt = "expires_at", url
    }
}

public struct GroupResponse: Codable, Sendable {
    public let group: Group
    public let invite: GroupInvite?

    public init(group: Group, invite: GroupInvite? = nil) {
        self.group = group
        self.invite = invite
    }
}

public struct GroupsResponse: Codable, Sendable {
    public let groups: [Group]

    public init(groups: [Group]) {
        self.groups = groups
    }
}
