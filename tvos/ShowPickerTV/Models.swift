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
    let posterUrl: String?
    let rating: Double?
    let nNeighbors: Int?
    let sharedActors: Int?

    var id: String { title }

    enum CodingKeys: String, CodingKey {
        case title, network, rating
        case networkUrl = "network_url"
        case posterUrl = "poster_url"
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
