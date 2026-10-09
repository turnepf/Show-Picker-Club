import Foundation

// Shared JSON shapes returned by showpicker.club. This is the superset used by
// every Apple client; each app layers its own platform-specific types (offline
// queue, cross-library search rows, iTunes lookups) on top.

public struct Actor: Codable, Hashable, Sendable {
    public let name: String
    public let imdbId: String?
    // The role played ("Mark S."), migration 073. Nil until enrichment has
    // stored it for the title, and for an uncredited part.
    public let character: String?

    public init(name: String, imdbId: String? = nil, character: String? = nil) {
        self.name = name
        self.imdbId = imdbId
        self.character = character
    }

    enum CodingKeys: String, CodingKey {
        case name, character
        case imdbId = "imdb_id"
    }
}

// A club member named in a show's "Watching with" — someone the owner shares a
// private group with, rather than a name they typed. The distinction matters
// because a named member's library is linked to this row: the title is on
// their list too, and their copy names the owner back.
public struct ShowWatcher: Codable, Identifiable, Hashable, Sendable {
    public let slug: String
    public let name: String

    public var id: String { slug }

    public init(slug: String, name: String) {
        self.slug = slug
        self.name = name
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
    // Where TMDB says the title streams today, comma-separated canonical
    // names. Sits beside `network`, which is the member's own answer and is
    // never overwritten — see docs/INVARIANTS.md §20. Empty string means TMDB
    // was asked and named nothing; nil means it was never asked, which is why
    // `streamingNote` distinguishes them.
    public let streamingOn: String?
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

    // Migration 064. The club members named in `watchingWith`, as people. Sent
    // only on the owner's own rows — as personal as `notes` — and empty when
    // the field is nothing but typed text. `watchingWith` remains the display
    // string (free text, then these names), so a client that ignores this
    // still renders the field correctly.
    public let watchers: [ShowWatcher]?

    // Who put this row here, when it wasn't the owner: the group-mate whose
    // Watching With tag created it. Owner-only like `watchers`, and nil on
    // rows the owner added themselves — so it exists exactly when "why is
    // this on my list" is a real question.
    public let addedByMember: ShowWatcher?

    // Migration 073. Each is nil until an enrichment pass has stored it for
    // this title, and the detail screen shows no row until then.
    //   imdbId     the title's IMDb id (tt…), for the IMDb link
    //   tmdbStatus TMDB's status verbatim ("Returning Series", "Canceled"…);
    //              see statusText for what is shown
    //   freeOn     free / free-with-ads services, encoded like streamingOn
    public let imdbId: String?
    public let tmdbStatus: String?
    public let freeOn: String?

    // The TMDB entry this copy is. Two different shows can share a title
    // (three 2026 films are called "The Odyssey"), so anything that asks "is
    // this the same show?" compares this first and falls back to the title
    // only when one side has no id.
    public let tmdbId: Int?

    // Migration 087. The season airing now (or next to start) and the day it
    // premiered, one answer per TMDB entry. nil until a refresh has stored
    // them. currentSeason is also a floor under seasonsReleased: TMDB's count
    // can trail the season actually airing, which read "4 seasons" to a member
    // watching season 5. See currentSeasonText / listLine.
    public let currentSeason: Int?
    public let seasonPremiereDate: String?

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
        studio: String? = nil,
        watchers: [ShowWatcher]? = nil,
        addedByMember: ShowWatcher? = nil,
        streamingOn: String? = nil,
        imdbId: String? = nil,
        tmdbStatus: String? = nil,
        freeOn: String? = nil,
        tmdbId: Int? = nil,
        currentSeason: Int? = nil,
        seasonPremiereDate: String? = nil
    ) {
        self.id = id
        self.title = title
        self.list = list
        self.streamingOn = streamingOn
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
        self.watchers = watchers
        self.addedByMember = addedByMember
        self.imdbId = imdbId
        self.tmdbStatus = tmdbStatus
        self.freeOn = freeOn
        self.tmdbId = tmdbId
        self.currentSeason = currentSeason
        self.seasonPremiereDate = seasonPremiereDate
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
        case streamingOn = "streaming_on"
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
        case watchers
        case addedByMember = "added_by_member"
        case imdbId = "imdb_id"
        case tmdbStatus = "tmdb_status"
        case freeOn = "free_on"
        case tmdbId = "tmdb_id"
        case currentSeason = "current_season"
        case seasonPremiereDate = "season_premiere_date"
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
        streamingOn = try? c.decode(String.self, forKey: .streamingOn)
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
        watchers = try? c.decode([ShowWatcher].self, forKey: .watchers)
        addedByMember = try? c.decode(ShowWatcher.self, forKey: .addedByMember)
        imdbId = try? c.decode(String.self, forKey: .imdbId)
        tmdbStatus = try? c.decode(String.self, forKey: .tmdbStatus)
        freeOn = try? c.decode(String.self, forKey: .freeOn)
        tmdbId = try? c.decode(Int.self, forKey: .tmdbId)
        currentSeason = try? c.decode(Int.self, forKey: .currentSeason)
        seasonPremiereDate = try? c.decode(String.self, forKey: .seasonPremiereDate)
    }

    public var isMovie: Bool { (movie ?? 0) == 1 }
    public var isFullSeries: Bool { (fullSeries ?? 0) == 1 }
    public var isArchived: Bool { (archived ?? 0) == 1 }

    public var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    public var streamingOnList: [String] {
        (streamingOn ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    // The line the detail screen shows under the network, or nil when there is
    // nothing worth saying.
    //
    // `network` is the member's record and is never overwritten, so it drifts
    // as licensing moves — 45% of films carried a network TMDB no longer
    // listed. Rather than correct their answer, say what TMDB says now:
    //
    //   • the card's network is among them  → "Also on Hulu" (the others)
    //   • it isn't, but TMDB names services → "Now on Paramount+"
    //   • TMDB names nothing, or was never asked → nil
    //
    // The nothing/never-asked cases both return nil on purpose: an empty
    // `streaming_on` means TMDB was asked and found no subscription service,
    // which is ordinary for a rental, and nil means nobody has looked. Neither
    // is worth a line, and claiming "streams nowhere" on the second would be
    // asserting something we never checked.
    public var streamingNote: String? {
        let services = streamingOnList
        guard !services.isEmpty else { return nil }
        let mine = (network ?? "").trimmingCharacters(in: .whitespaces)
        if !mine.isEmpty, services.contains(where: { $0.caseInsensitiveCompare(mine) == .orderedSame }) {
            let others = services.filter { $0.caseInsensitiveCompare(mine) != .orderedSame }
            guard !others.isEmpty else { return nil }
            return "Also on \(others.joined(separator: ", "))"
        }
        return "Now on \(services.joined(separator: ", "))"
    }

    // The same answer, split for a two-column row: the relationship belongs in
    // the label and the services in the value, so it reads in parallel with
    // the Network row above it rather than repeating "on" inside its own text.
    //
    //   Network      MGM+
    //   Now on       Apple TV+
    //
    // `label` is the part that must not be flattened to one word. "Also on"
    // means the member's own service still carries it and these are extra;
    // "Now on" means it doesn't carry it any more and these are where it went.
    // Calling the second one "Also on" would assert the member's service still
    // has it, which is the opposite of what TMDB just said.
    public var streamingRow: (label: String, services: String)? {
        guard let note = streamingNote else { return nil }
        for prefix in ["Also on ", "Now on "] where note.hasPrefix(prefix) {
            return (String(prefix.dropLast()), String(note.dropFirst(prefix.count)))
        }
        return nil
    }

    // The season count to show: TMDB's count, but never less than the season
    // airing now. nil for a movie or when neither is known.
    public var seasonCount: Int? {
        guard !isMovie else { return nil }
        let n = max(seasonsReleased ?? 0, currentSeason ?? 0)
        return n > 0 ? n : nil
    }

    // "3 seasons" / "1 season" — total seasons released, when known.
    public var seasonsText: String? {
        guard let n = seasonCount else { return nil }
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
        if let n = seasonCount {
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

    // Today as YYYY-MM-DD on this device. The stored dates are air dates, so
    // they compare as strings against the member's own calendar day.
    public static func todayString(_ date: Date = Date()) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: date)
    }

    // The stored next episode, but only while it's still ahead (today counts).
    // A date that has passed means the refresh hasn't caught up since the
    // episode aired, and showing it read "Next episode: 10/7" on 10/8.
    public func upcomingNextDate(today: String = Show.todayString()) -> String? {
        guard let d = nextSeasonDate, !d.isEmpty, d >= today else { return nil }
        return d
    }

    // Next episode ("6/1"); nil without an upcoming date. Used on the
    // Watching/Awaiting list rows. Deliberately just the one date — the
    // finale date stays off "Next episode" everywhere.
    public var nextUpRange: String? { nextUpRange(today: Show.todayString()) }

    public func nextUpRange(today: String) -> String? {
        monthDay(upcomingNextDate(today: today))
    }

    // Whatever season dates are still ahead, for the detail view (falls back
    // to a finale-only "through M/D").
    public var seasonDatesText: String? { seasonDatesText(today: Show.todayString()) }

    public func seasonDatesText(today: String) -> String? {
        if let r = nextUpRange(today: today) { return r }
        if let end = seasonEndDate, !end.isEmpty, end >= today, let md = monthDay(end) { return "through \(md)" }
        return nil
    }

    // "Season 6 · premiered 9/16" while a season is on, "Season 6 premieres
    // 10/14" before it starts. Shown only while the season is current: about to
    // start, or with a next episode stored on this copy (Watching and Awaiting
    // carry one, and a passed one still means the season was airing at the
    // last refresh). A finished season says nothing here; the count covers it.
    public var currentSeasonText: String? { currentSeasonText(today: Show.todayString()) }

    public func currentSeasonText(today: String) -> String? {
        guard let row = currentSeasonRow(today: today) else { return nil }
        return row.upcoming ? "\(row.label) premieres \(row.date)" : "\(row.label) · premiered \(row.date)"
    }

    // The same, split for the detail screen's two-column rows:
    //   Season 6      Premiered 9/16
    public var currentSeasonRow: (label: String, value: String)? {
        guard let row = currentSeasonRow(today: Show.todayString()) else { return nil }
        return (row.label, "\(row.upcoming ? "Premieres" : "Premiered") \(row.date)")
    }

    func currentSeasonRow(today: String) -> (label: String, date: String, upcoming: Bool)? {
        guard !isMovie, let n = currentSeason, n > 0,
              let premiere = seasonPremiereDate, !premiere.isEmpty, let md = monthDay(premiere) else { return nil }
        if premiere > today { return ("Season \(n)", md, true) }
        guard let next = nextSeasonDate, !next.isEmpty else { return nil }
        return ("Season \(n)", md, false)
    }

    // The season's last episode ("11/4") while it's still ahead; nil when
    // unknown or passed. Computed only for Watching and Awaiting copies.
    public func upcomingFinale(today: String) -> String? {
        // A one-episode season ends the day it premieres; "premieres 10/14 ·
        // finale 10/14" would say the same date twice.
        guard let end = seasonEndDate, !end.isEmpty, end >= today,
              end != seasonPremiereDate else { return nil }
        return monthDay(end)
    }

    // The season line under a list row:
    //   "Season 6 · premiered 9/16 · next 10/14 · finale 11/4"   a season on air
    //   "Season 6 · premiered 9/16 · finale 10/14"               its last episode is next
    //   "Season 7 premieres 10/14 · finale 12/2"                 one about to start
    //   "Next episode: 10/14 · finale 11/4 · 6 seasons"          no season data yet
    //   "6 seasons"                                              nothing coming up
    // The finale shows only when a refresh has dated it.
    public var listLine: String? { listLine(today: Show.todayString()) }

    public func listLine(today: String) -> String? {
        let finale = upcomingFinale(today: today)
        // When the next episode IS the finale, say "finale" once, not both.
        let nextIsFinale = upcomingNextDate(today: today) != nil && nextSeasonDate == seasonEndDate
        let next = nextIsFinale ? nil : nextUpRange(today: today)
        let finalePart = finale.map { "finale \($0)" }
        if let current = currentSeasonText(today: today) {
            let upcoming = current.contains("premieres")
            return [current, upcoming ? nil : next.map { "next \($0)" }, finalePart]
                .compactMap { $0 }.joined(separator: " · ")
        }
        if let next { return [ "Next episode: \(next)", finalePart, seasonsText ].compactMap { $0 }.joined(separator: " · ") }
        if let finale { return [ "Finale: \(finale)", seasonsText ].compactMap { $0 }.joined(separator: " · ") }
        return seasonsText
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

    // The title's IMDb page, or nil when no id is stored yet. The server only
    // stores the tt… shape; checked again here because it goes into a URL.
    public var imdbURL: URL? {
        guard let id = imdbId, id.hasPrefix("tt"), id.dropFirst(2).allSatisfy(\.isNumber),
              id.count > 2 else { return nil }
        return URL(string: "https://www.imdb.com/title/\(id)/")
    }

    // TMDB's status as the detail screen words it, or nil when there's
    // nothing worth a row: not stored yet, or a released film (every film on
    // a list is released; saying so is noise). A word we don't recognise is
    // shown as TMDB wrote it rather than hidden.
    public var statusText: String? {
        guard let raw = tmdbStatus?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        switch raw.lowercased() {
        case "released": return nil
        case "returning series": return "Returning"
        case "ended": return "Ended"
        case "canceled", "cancelled": return "Canceled"
        case "in production": return "In production"
        case "post production": return "Post-production"
        case "planned", "pilot", "rumored": return "Planned"
        default: return raw
        }
    }

    public var freeOnList: [String] {
        (freeOn ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    // Free / with-ads services for the "Free on" row, minus the member's own
    // network (already named on the row above). Nil when there are none —
    // never asked and asked-but-none read alike, as with streamingNote.
    public var freeOnText: String? {
        let mine = (network ?? "").trimmingCharacters(in: .whitespaces)
        let services = freeOnList.filter { $0.caseInsensitiveCompare(mine) != .orderedSame }
        return services.isEmpty ? nil : services.joined(separator: ", ")
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
    // Creator-picked SF Symbol and named accent color (migration 066). Either
    // can be nil — a group without them renders name-only, as before.
    public let icon: String?
    public let color: String?

    public init(id: Int, name: String, creatorSlug: String, createdAt: String, memberCount: Int = 0, isCreator: Bool = false, icon: String? = nil, color: String? = nil) {
        self.id = id
        self.name = name
        self.creatorSlug = creatorSlug
        self.createdAt = createdAt
        self.memberCount = memberCount
        self.isCreator = isCreator
        self.icon = icon
        self.color = color
    }

    enum CodingKeys: String, CodingKey {
        case id, name, creatorSlug = "creator_slug", createdAt = "created_at"
        case memberCount = "member_count", isCreator = "is_creator"
        case icon, color
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
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        color = try c.decodeIfPresent(String.self, forKey: .color)
    }
}

// The curated choices the group-icon picker offers, mirroring the server's
// sets in functions/_shared/group-icons.js — the server rejects anything
// outside them, so the apps and the API can't drift apart silently. Kept here
// (Foundation-only) as plain strings; mapping a color name to a platform
// Color happens in each app.
public enum GroupIcon {
    public static let symbols: [String] = [
        "person.2.fill", "person.3.fill", "house.fill", "sofa.fill", "tv.fill",
        "film.fill", "theatermasks.fill", "star.fill", "heart.fill", "flame.fill",
        "sparkles", "moon.stars.fill", "sun.max.fill", "bolt.fill", "crown.fill",
        "gamecontroller.fill", "pawprint.fill", "leaf.fill", "book.fill",
        "music.note", "globe.americas.fill", "airplane", "fork.knife",
        "cup.and.saucer.fill",
    ]

    public static let colors: [String] = [
        "red", "orange", "yellow", "green", "teal", "blue", "indigo", "purple",
        "pink", "brown",
    ]
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
    // Set once, the visit after somebody other than me renamed the group or
    // changed its icon (migration 068) — GET clears my own high-water mark
    // as it hands this back, so a second load of the same screen won't carry
    // it again.
    public let changeNotice: GroupChangeNotice?

    public init(group: Group, members: [GroupMember], isCreator: Bool = false, canManage: Bool = false, changeNotice: GroupChangeNotice? = nil) {
        self.group = group
        self.members = members
        self.isCreator = isCreator
        self.canManage = canManage
        self.changeNotice = changeNotice
    }

    enum CodingKeys: String, CodingKey {
        case group, members, isCreator = "is_creator", canManage = "can_manage"
        case changeNotice = "change_notice"
    }
}

// Who last renamed a group or changed its icon, and what they touched —
// rename and icon/color are the only two things a member profile edit can
// touch, so `summary` only ever has to say one or both.
public struct GroupChangeNotice: Codable, Sendable {
    public let changedBy: String
    public let changedByName: String
    public let changedFields: [String]
    public let changedAt: String

    public init(changedBy: String, changedByName: String, changedFields: [String], changedAt: String) {
        self.changedBy = changedBy
        self.changedByName = changedByName
        self.changedFields = changedFields
        self.changedAt = changedAt
    }

    enum CodingKeys: String, CodingKey {
        case changedBy = "changed_by", changedByName = "changed_by_name"
        case changedFields = "changed_fields", changedAt = "changed_at"
    }

    public var summary: String {
        let hasName = changedFields.contains("name")
        let hasIcon = changedFields.contains("icon")
        switch (hasName, hasIcon) {
        case (true, true): return "\(changedByName) renamed the group and changed its icon."
        case (true, false): return "\(changedByName) renamed the group."
        case (false, true): return "\(changedByName) changed the group's icon."
        default: return "\(changedByName) updated the group."
        }
    }
}

// Identifiable so an invite can drive `.sheet(item:)` directly — presenting the
// invite sheet off a separate Bool renders it before the invite lands.
public struct GroupInvite: Codable, Identifiable, Sendable {
    public let token: String
    public let expiresAt: String
    public let url: String
    // How many people the link will let in — ten, set by the server since
    // migration 070. Optional because a response minted before the server
    // reported it (a cached one, an older deployment) must still decode: the
    // sheet drops that half of its line rather than naming a number nobody
    // sent.
    public let maxUses: Int?

    public var id: String { token }

    public init(token: String, expiresAt: String, url: String, maxUses: Int? = nil) {
        self.token = token
        self.expiresAt = expiresAt
        self.url = url
        self.maxUses = maxUses
    }

    enum CodingKeys: String, CodingKey {
        case token, expiresAt = "expires_at", url, maxUses = "max_uses"
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

// One card on a group's recommendation board ("Recommend to group", migration
// 065), shaped by the server for the viewing member: `isYours` and
// `yourResponse` decide whether the pop-up still asks them, `onYourList`
// labels the Add button honestly, and `showId` is the recommender's copy —
// the same cross-member id Trending cards navigate with, nil once they
// delete that copy (the snapshot fields still render the card).
public struct GroupSuggestion: Codable, Identifiable, Hashable, Sendable {
    public let id: Int
    public let groupId: Int
    public let showId: Int?
    public let title: String
    public let tmdbId: Int?
    public let isMovie: Bool
    public let posterUrl: String?
    public let network: String?
    public let note: String?
    public let createdAt: String?
    public let suggestedBy: String
    public let suggestedByName: String
    public let isYours: Bool
    /// "dismissed" or "added" once this member has answered; nil until then.
    public let yourResponse: String?
    public let addedCount: Int
    public let addedNames: [String]
    /// The list the viewer's own active copy sits on, nil if they have none.
    public let onYourList: String?

    /// Whether the pop-up should still ask this member: not their own card,
    /// and not yet answered.
    public var needsResponse: Bool { !isYours && yourResponse == nil }

    public init(
        id: Int,
        groupId: Int,
        showId: Int? = nil,
        title: String,
        tmdbId: Int? = nil,
        isMovie: Bool = false,
        posterUrl: String? = nil,
        network: String? = nil,
        note: String? = nil,
        createdAt: String? = nil,
        suggestedBy: String,
        suggestedByName: String,
        isYours: Bool = false,
        yourResponse: String? = nil,
        addedCount: Int = 0,
        addedNames: [String] = [],
        onYourList: String? = nil
    ) {
        self.id = id
        self.groupId = groupId
        self.showId = showId
        self.title = title
        self.tmdbId = tmdbId
        self.isMovie = isMovie
        self.posterUrl = posterUrl
        self.network = network
        self.note = note
        self.createdAt = createdAt
        self.suggestedBy = suggestedBy
        self.suggestedByName = suggestedByName
        self.isYours = isYours
        self.yourResponse = yourResponse
        self.addedCount = addedCount
        self.addedNames = addedNames
        self.onYourList = onYourList
    }

    enum CodingKeys: String, CodingKey {
        case id, title, note, network
        case groupId = "group_id"
        case showId = "show_id"
        case tmdbId = "tmdb_id"
        case isMovie = "movie"
        case posterUrl = "poster_url"
        case createdAt = "created_at"
        case suggestedBy = "suggested_by"
        case suggestedByName = "suggested_by_name"
        case isYours = "is_yours"
        case yourResponse = "your_response"
        case addedCount = "added_count"
        case addedNames = "added_names"
        case onYourList = "on_your_list"
    }

    // D1 has no boolean type, so `movie` and `is_yours` arrive as 1/0 — read
    // a real JSON boolean too, same as Group.isCreator. Everything beyond the
    // card's identity decodes as absent-means-default so a payload trimmed by
    // an older (or newer) server never fails the whole board.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        groupId = try c.decodeIfPresent(Int.self, forKey: .groupId) ?? 0
        showId = try c.decodeIfPresent(Int.self, forKey: .showId)
        title = try c.decode(String.self, forKey: .title)
        tmdbId = try c.decodeIfPresent(Int.self, forKey: .tmdbId)
        if let flag = try? c.decode(Bool.self, forKey: .isMovie) {
            isMovie = flag
        } else {
            isMovie = (try c.decodeIfPresent(Int.self, forKey: .isMovie) ?? 0) != 0
        }
        posterUrl = try c.decodeIfPresent(String.self, forKey: .posterUrl)
        network = try c.decodeIfPresent(String.self, forKey: .network)
        note = try c.decodeIfPresent(String.self, forKey: .note)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        suggestedBy = try c.decodeIfPresent(String.self, forKey: .suggestedBy) ?? ""
        suggestedByName = try c.decodeIfPresent(String.self, forKey: .suggestedByName) ?? suggestedBy
        if let flag = try? c.decode(Bool.self, forKey: .isYours) {
            isYours = flag
        } else {
            isYours = (try c.decodeIfPresent(Int.self, forKey: .isYours) ?? 0) != 0
        }
        yourResponse = try c.decodeIfPresent(String.self, forKey: .yourResponse)
        addedCount = try c.decodeIfPresent(Int.self, forKey: .addedCount) ?? 0
        addedNames = try c.decodeIfPresent([String].self, forKey: .addedNames) ?? []
        onYourList = try c.decodeIfPresent(String.self, forKey: .onYourList)
    }
}

public struct GroupSuggestionsResponse: Codable, Sendable {
    public let suggestions: [GroupSuggestion]

    public init(suggestions: [GroupSuggestion]) {
        self.suggestions = suggestions
    }
}
