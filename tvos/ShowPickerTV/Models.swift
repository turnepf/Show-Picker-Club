import Foundation

// Mirrors the JSON shapes returned by the showpicker.club API.
// View-only client: we never POST from tvOS.

struct Member: Codable, Identifiable, Hashable {
    var id: String { slug }
    let slug: String
    let name: String
    let firstName: String?
    let displayName: String?
    let showCount: Int?
    let watchingCount: Int?
    let waitingCount: Int?
    let recommendingCount: Int?
    let nextCount: Int?
    let lastActivityAt: String?

    enum CodingKeys: String, CodingKey {
        case slug, name
        case firstName = "first_name"
        case displayName = "display_name"
        case showCount = "show_count"
        case watchingCount = "watching_count"
        case waitingCount = "waiting_count"
        case recommendingCount = "recommending_count"
        case nextCount = "next_count"
        case lastActivityAt = "last_activity_at"
    }

    var label: String { displayName ?? firstName ?? name }

    // "Most active" = engaged lists: Watching + Up Next + Recommending.
    var activeCount: Int {
        (watchingCount ?? 0) + (nextCount ?? 0) + (recommendingCount ?? 0)
    }
}

struct MembersResponse: Codable { let members: [Member] }

// MARK: Auth

struct AuthCheckResponse: Codable {
    let authenticated: Bool
    let email: String?
    let member: String?
    let isAdmin: Bool?

    enum CodingKeys: String, CodingKey {
        case authenticated, email, member
        case isAdmin = "is_admin"
    }
}

struct LoginResponse: Codable {
    let success: Bool?
    let slug: String?
    let error: String?
}

// /auth/request-code reply.
struct Ack: Codable { let success: Bool? }

struct Actor: Codable, Hashable {
    let name: String
    let imdbId: String?
    enum CodingKeys: String, CodingKey {
        case name
        case imdbId = "imdb_id"
    }
}

struct Show: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let network: String?
    let networkUrl: String?
    let recommendedBy: String?
    let rating: String?
    let list: String
    let notes: String?
    let movie: Int?
    let fullSeries: Int?
    let watchingWith: String?
    let nextSeasonDate: String?
    let seasonEndDate: String?
    let seasonsReleased: Int?
    let genres: String?
    let memberSlug: String?
    let posterUrl: String?
    let networkLogoUrl: String?
    // The API returns actors as a JSON-encoded string (from SQLite
    // json_group_array). Decoded lazily via `castMembers`.
    let actors: String?

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, list, notes, movie, genres, actors
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
    }

    var isMovie: Bool { (movie ?? 0) == 1 }
    var isFullSeries: Bool { (fullSeries ?? 0) == 1 }

    var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    // "3 seasons" when known. Mirrors the iOS row metadata.
    var seasonsText: String? {
        guard let n = seasonsReleased, n > 0 else { return nil }
        return "\(n) season\(n == 1 ? "" : "s")"
    }

    // Premiere of the next season ("6/1" or "6/1 – 6/30"), matching iOS/web.
    var nextUpRange: String? {
        guard let start = monthDay(nextSeasonDate) else { return nil }
        if let end = monthDay(seasonEndDate), end != start { return "\(start) – \(end)" }
        return start
    }

    private func monthDay(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        let p = s.split(separator: "-")
        guard p.count >= 3, let m = Int(p[1]), let d = Int(p[2]) else { return s }
        return "\(m)/\(d)"
    }

    var castMembers: [Actor] {
        guard let actors, let data = actors.data(using: .utf8) else { return [] }
        return (try? JSONDecoder().decode([Actor].self, from: data)) ?? []
    }

    // A real deep link (not a search-page placeholder). HBO Max search
    // URLs are an intentional fallback — Watchmode only knows some HBO
    // titles via auto-play URLs we can't use, so the search page is the
    // best stable option. Allow those through; the detail view prefers
    // Apple TV routing for them anyway, so users land on the show page
    // rather than HBO Max search whenever possible.
    var hasRealUrl: Bool {
        guard let u = networkUrl?.lowercased() else { return false }
        if u.isEmpty || u == "#" { return false }
        if u.hasPrefix("https://play.hbomax.com/search?") { return true }
        if u.hasPrefix("https://play.hbomax.com/search/result?") { return true }
        return !(u.contains("/search") || u.contains("/s?") || u.contains("?q=") || u.contains("?query="))
    }

    var isHBOMaxSearchFallback: Bool {
        guard let u = networkUrl?.lowercased() else { return false }
        return u.hasPrefix("https://play.hbomax.com/search?")
            || u.hasPrefix("https://play.hbomax.com/search/result?")
    }
}

struct ShowsResponse: Codable { let shows: [Show] }
struct ShowResponse: Codable { let show: Show }
struct ActorsResponse: Codable { let actors: [Actor] }

struct PopularShow: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let network: String?
    let networkUrl: String?
    let rating: String?
    let genres: String?
    let members: [String]?
    let posterUrl: String?
    let networkLogoUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, genres, members
        case networkUrl = "network_url"
        case posterUrl = "poster_url"
        case networkLogoUrl = "network_logo_url"
    }
}

struct PopularResponse: Codable { let shows: [PopularShow] }

// MARK: Recommendations ("Picks for you")

struct Recommendations: Codable {
    let coldStart: Bool?
    let isSeedOnly: Bool?
    let picks: [Pick]

    enum CodingKeys: String, CodingKey {
        case picks
        case coldStart = "cold_start"
        case isSeedOnly = "is_seed_only"
    }
}

struct Pick: Codable, Identifiable, Hashable {
    let title: String
    let network: String?
    let networkUrl: String?
    let rating: Double?
    let nNeighbors: Int?
    let sharedActors: Int?

    var id: String { title }

    enum CodingKeys: String, CodingKey {
        case title, network, rating
        case networkUrl = "network_url"
        case nNeighbors = "n_neighbors"
        case sharedActors = "shared_actors"
    }

    // A short de-named reason (no network — the card shows that separately).
    var reason: String {
        let n = nNeighbors ?? 0
        if n > 0 {
            return n == 1 ? "On 1 member's list" : "On \(n) members' lists"
        } else if let a = sharedActors, a > 0 {
            return "\(a) shared actor\(a == 1 ? "" : "s")"
        }
        return "Popular in the club"
    }
}

// The four lists, in display order.
enum ShowList: String, CaseIterable, Identifiable {
    case watching, waiting, recommending, next
    var id: String { rawValue }
    var title: String {
        switch self {
        case .watching: return "Watching"
        case .waiting: return "Waiting"
        case .recommending: return "Recommending"
        case .next: return "Up Next"
        }
    }
}
