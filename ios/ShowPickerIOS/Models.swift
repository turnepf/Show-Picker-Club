import Foundation

// Mirrors the JSON shapes returned by showpicker.club. Same schema as the
// tvOS client; iPhone gets the extra write paths (POST/PUT) below.

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
    let actors: String?
    let archived: Int?
    let memberSlug: String?

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, list, notes, movie, genres, actors, archived
        case networkUrl = "network_url"
        case recommendedBy = "recommended_by"
        case fullSeries = "full_series"
        case watchingWith = "watching_with"
        case nextSeasonDate = "next_season_date"
        case seasonEndDate = "season_end_date"
        case memberSlug = "member_slug"
    }

    var isMovie: Bool { (movie ?? 0) == 1 }
    var isFullSeries: Bool { (fullSeries ?? 0) == 1 }
    var isArchived: Bool { (archived ?? 0) == 1 }
    var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
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

// Auth check response.
struct AuthCheckResponse: Codable {
    let authenticated: Bool
    let email: String?
    let member: String?
}

// Login response.
struct LoginResponse: Codable {
    let success: Bool?
    let slug: String?
    let error: String?
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

// Canonical networks for the picker. Keep in sync with
// functions/_shared/networks.js on the backend.
let CANONICAL_NETWORKS: [String] = [
    "AMC+",
    "Amazon Prime Video",
    "Apple TV+",
    "Disney+",
    "Food Network",
    "Fox",
    "HBO Max",
    "Hulu",
    "Netflix",
    "Paramount+",
    "Peacock",
    "Starz",
]
