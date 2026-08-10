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

    // Migration 063. episodesReleased is the companion to seasonsReleased —
    // "4 seasons" says nothing about size on its own — and rides along on
    // seriesText. tagline renders above the overview; originalLanguage is shown
    // only when it isn't English, since an "English" row on nearly every card
    // is noise. voteCount and studio are stored but deliberately not displayed;
    // ARCHITECTURE.md's shows table says why for each.
    public let episodesReleased: Int?
    public let voteCount: Int?
    public let tagline: String?
    public let originalLanguage: String?   // ISO code: "ja", "ko", …
    public let studio: String?             // originating studio/broadcaster, NOT the streaming service

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
        directorImdbId: String? = nil,
        episodesReleased: Int? = nil,
        voteCount: Int? = nil,
        tagline: String? = nil,
        originalLanguage: String? = nil,
        studio: String? = nil
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
        self.episodesReleased = episodesReleased
        self.voteCount = voteCount
        self.tagline = tagline
        self.originalLanguage = originalLanguage
        self.studio = studio
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
        case episodesReleased = "episodes_released"
        case voteCount = "vote_count"
        case tagline
        case originalLanguage = "original_language"
        case studio
    }

    // Tolerant decoding. The API varies what it sends by context — `list` and
    // `member_slug` are session-only, catalog fields appear as migrations land
    // — and Swift's synthesized Decodable is all-or-nothing: one missing or
    // differently-shaped required field throws, the caller catches, and an
    // entire screen reads "couldn't load" while every other field sat there
    // decoded fine. That failure has cost us a blank show card (list absent
    // for a logged-out visitor) and looked like a server outage both times.
    //
    // So: only `id` and `title` are genuinely required — without them there's
    // no show — and everything else falls back rather than failing the whole
    // payload. Real breakage still surfaces; it just surfaces as one empty
    // row instead of an empty screen.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        list = (try? c.decode(String.self, forKey: .list)) ?? ""
        network = try? c.decode(String.self, forKey: .network)
        networkUrl = try? c.decode(String.self, forKey: .networkUrl)
        recommendedBy = try? c.decode(String.self, forKey: .recommendedBy)
        rating = try? c.decode(String.self, forKey: .rating)
        notes = try? c.decode(String.self, forKey: .notes)
        movie = try? c.decode(Int.self, forKey: .movie)
        fullSeries = try? c.decode(Int.self, forKey: .fullSeries)
        watchingWith = try? c.decode(String.self, forKey: .watchingWith)
        nextSeasonDate = try? c.decode(String.self, forKey: .nextSeasonDate)
        seasonEndDate = try? c.decode(String.self, forKey: .seasonEndDate)
        seasonsReleased = try? c.decode(Int.self, forKey: .seasonsReleased)
        genres = try? c.decode(String.self, forKey: .genres)
        memberSlug = try? c.decode(String.self, forKey: .memberSlug)
        posterUrl = try? c.decode(String.self, forKey: .posterUrl)
        networkLogoUrl = try? c.decode(String.self, forKey: .networkLogoUrl)
        createdAt = try? c.decode(String.self, forKey: .createdAt)
        archived = try? c.decode(Int.self, forKey: .archived)
        sortOrder = try? c.decode(Int.self, forKey: .sortOrder)
        actors = try? c.decode(String.self, forKey: .actors)
        overview = try? c.decode(String.self, forKey: .overview)
        backdropUrl = try? c.decode(String.self, forKey: .backdropUrl)
        tmdbRating = try? c.decode(String.self, forKey: .tmdbRating)
        contentRating = try? c.decode(String.self, forKey: .contentRating)
        trailerKey = try? c.decode(String.self, forKey: .trailerKey)
        director = try? c.decode(String.self, forKey: .director)
        directorImdbId = try? c.decode(String.self, forKey: .directorImdbId)
        runtime = try? c.decode(Int.self, forKey: .runtime)
        releaseYear = try? c.decode(Int.self, forKey: .releaseYear)
        watchLink = try? c.decode(String.self, forKey: .watchLink)
        episodesReleased = try? c.decode(Int.self, forKey: .episodesReleased)
        voteCount = try? c.decode(Int.self, forKey: .voteCount)
        tagline = try? c.decode(String.self, forKey: .tagline)
        originalLanguage = try? c.decode(String.self, forKey: .originalLanguage)
        studio = try? c.decode(String.self, forKey: .studio)
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

    // Combined series line for the detail screen: "4 Seasons · 19 Episodes,
    // Complete" while ended, "2 Seasons" while running, or just "Complete" when
    // the count is unknown. nil when neither a count nor the ended flag is set.
    //
    // The episode count rides on the season count with a middot rather than
    // taking its own row: the question it answers ("how much am I signing up
    // for") is the same question, and "4 Seasons" alone is what makes it
    // unanswerable. Dropped when we don't have it, and for movies, which have
    // no episode count at all.
    public var seriesText: String? {
        var parts: [String] = []
        if let n = seasonsReleased, n > 0 {
            var count = "\(n) Season\(n == 1 ? "" : "s")"
            if let e = episodesReleased, e > 0 {
                count += " · \(e) Episode\(e == 1 ? "" : "s")"
            }
            parts.append(count)
        }
        if isFullSeries { parts.append("Complete") }
        return parts.isEmpty ? nil : parts.joined(separator: ", ")
    }

    // Production language, spelled out ("Japanese", "Korean") — but only when
    // it isn't English. A "Language: English" row would appear on nearly every
    // card in the club and tell nobody anything; the field earns its place
    // precisely when it's a surprise. nil when the code is missing, English, or
    // one Locale can't name.
    public var originalLanguageText: String? {
        guard let code = originalLanguage?.lowercased(), !code.isEmpty, code != "en" else { return nil }
        guard let name = Locale.current.localizedString(forLanguageCode: code) else { return nil }
        return name.prefix(1).uppercased() + name.dropFirst()
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
    // Creators as individually linkable people. `show.director` is one
    // comma-joined string carrying a single IMDB id for the first credit, so
    // a co-created show could only ever link one name; the server resolves
    // each name against the canonical people table instead.
    public let creators: [Credit]?
    // Other members of MY groups with this same title on their Watching
    // list — a sibling of `show` too, and empty unless the viewer is in a
    // group with someone who's watching it.
    public let groupWatchers: [GroupWatcher]?

    // Explicit public init — the synthesized memberwise init is only
    // internal even though the struct is public, so other modules (the
    // apps' offline-cache fallbacks) couldn't construct one without this.
    public init(show: Show, ratings: RatingsSummary? = nil, groupWatchers: [GroupWatcher]? = nil,
                creators: [Credit]? = nil) {
        self.show = show
        self.ratings = ratings
        self.groupWatchers = groupWatchers
        self.creators = creators
    }

    enum CodingKeys: String, CodingKey {
        case show, ratings, creators, groupWatchers = "group_watchers"
    }
}

// One fellow group member watching a title. First name only — that's all
// the endpoint sends, and all the card needs.
// One credited person, with their IMDB id when we know it. Same shape for
// creators and cast.
public struct Credit: Codable, Identifiable, Hashable, Sendable {
    public let name: String
    public let imdbId: String?

    public var id: String { name }

    public var url: URL? {
        guard let imdbId, !imdbId.isEmpty else { return nil }
        return URL(string: "https://www.imdb.com/name/\(imdbId)/")
    }

    public init(name: String, imdbId: String? = nil) {
        self.name = name
        self.imdbId = imdbId
    }

    enum CodingKeys: String, CodingKey {
        case name
        case imdbId = "imdb_id"
    }
}

public struct GroupWatcher: Codable, Identifiable, Hashable, Sendable {
    public let slug: String
    public let name: String

    public var id: String { slug }

    public init(slug: String, name: String) {
        self.slug = slug
        self.name = name
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

    // member_count / is_creator are computed columns the group list carries but
    // a single-group payload may not, so they decode as absent-means-default
    // rather than failing the whole group.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        creatorSlug = try c.decode(String.self, forKey: .creatorSlug)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        memberCount = try c.decodeIfPresent(Int.self, forKey: .memberCount) ?? 0
        // D1 has no boolean type, so is_creator arrives as 1/0 from the SQL
        // CASE — but read a real JSON boolean too, in case the endpoint ever
        // computes it in JS the way the group-detail payload does.
        // A missing key throws here too, and lands on the Int branch's default.
        if let flag = try? c.decode(Bool.self, forKey: .isCreator) {
            isCreator = flag
        } else {
            isCreator = (try c.decodeIfPresent(Int.self, forKey: .isCreator) ?? 0) != 0
        }
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
