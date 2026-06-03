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
    let lastActivityAt: String?

    enum CodingKeys: String, CodingKey {
        case slug, name
        case firstName = "first_name"
        case displayName = "display_name"
        case showCount = "show_count"
        case watchingCount = "watching_count"
        case waitingCount = "waiting_count"
        case lastActivityAt = "last_activity_at"
    }

    var label: String { displayName ?? firstName ?? name }
}

struct MembersResponse: Codable { let members: [Member] }

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
    let genres: String?
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
    }

    var isMovie: Bool { (movie ?? 0) == 1 }
    var isFullSeries: Bool { (fullSeries ?? 0) == 1 }

    var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
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
        return !(u.contains("/search") || u.contains("/s?") || u.contains("?q=") || u.contains("?query="))
    }

    var isHBOMaxSearchFallback: Bool {
        guard let u = networkUrl?.lowercased() else { return false }
        return u.hasPrefix("https://play.hbomax.com/search?")
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

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, genres, members
        case networkUrl = "network_url"
    }
}

struct PopularResponse: Codable { let shows: [PopularShow] }

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
