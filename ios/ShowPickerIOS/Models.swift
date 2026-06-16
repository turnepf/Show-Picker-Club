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
    let createdAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, list, notes, movie, genres, actors, archived
        case networkUrl = "network_url"
        case recommendedBy = "recommended_by"
        case fullSeries = "full_series"
        case watchingWith = "watching_with"
        case nextSeasonDate = "next_season_date"
        case seasonEndDate = "season_end_date"
        case memberSlug = "member_slug"
        case createdAt = "created_at"
    }

    var isMovie: Bool { (movie ?? 0) == 1 }
    var isFullSeries: Bool { (fullSeries ?? 0) == 1 }
    var isArchived: Bool { (archived ?? 0) == 1 }
    var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    // Format an ISO "YYYY-MM-DD" as "M/D", matching the web's formatDate.
    private func monthDay(_ s: String?) -> String? {
        guard let s, !s.isEmpty else { return nil }
        let p = s.split(separator: "-")
        guard p.count >= 3, let m = Int(p[1]), let d = Int(p[2]) else { return s }
        return "\(m)/\(d)"
    }

    // Premiere of the next season ("6/1" or "6/1 – 6/30"); nil without a
    // premiere date. Used on the Watching/Waiting list rows.
    var nextUpRange: String? {
        guard let start = monthDay(nextSeasonDate) else { return nil }
        if let end = monthDay(seasonEndDate), end != start { return "\(start) – \(end)" }
        return start
    }

    // Whatever season dates exist, for the detail view (falls back to a
    // finale-only "through M/D").
    var seasonDatesText: String? {
        if let r = nextUpRange { return r }
        if let end = monthDay(seasonEndDate) { return "through \(end)" }
        return nil
    }
}

struct ShowsResponse: Codable { let shows: [Show] }
struct ShowResponse: Codable { let show: Show }
struct ActorsResponse: Codable { let actors: [Actor] }

// One row from /api/shows/all — every active show across all members, used by
// cross-library search. Carries member attribution + cast so results can read
// "on Watching · William" and be filtered by actor.
struct AllShow: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let network: String?
    let networkUrl: String?
    let rating: String?
    let movie: Int?
    let fullSeries: Int?
    let list: String
    let memberSlug: String
    let genres: String?
    let memberName: String?
    let memberFirstName: String?
    let actors: String?

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, movie, list, genres, actors
        case networkUrl = "network_url"
        case fullSeries = "full_series"
        case memberSlug = "member_slug"
        case memberName = "member_name"
        case memberFirstName = "member_first_name"
    }

    var isMovie: Bool { (movie ?? 0) == 1 }
    var isFullSeries: Bool { (fullSeries ?? 0) == 1 }
    var listLabel: String { ShowList(rawValue: list)?.title ?? list.capitalized }
    var ownerLabel: String {
        if let f = memberFirstName, !f.isEmpty { return f }
        if let n = memberName, let first = n.split(separator: " ").first { return String(first) }
        return memberSlug
    }
    var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    // Flattened actor names for substring matching, mirroring the web's
    // actorNamesText(): the `actors` column is a JSON array of {name,imdb_id}.
    var actorNamesText: String {
        guard let actors, let data = actors.data(using: .utf8),
              let arr = try? JSONDecoder().decode([Actor].self, from: data) else { return "" }
        return arr.map { $0.name }.joined(separator: " ")
    }
}

struct AllShowsResponse: Codable { let shows: [AllShow] }

// /api/shows/share response. `duplicate` means the target already had it; if
// `archived` they'd archived it, otherwise `list` is where it currently sits.
struct ShareResponse: Codable {
    let success: Bool?
    let duplicate: Bool?
    let archived: Bool?
    let list: String?
    let error: String?
}

enum ShareOutcome {
    case sent
    case duplicate(list: String?)
    case duplicateArchived
}

// /api/recommendations — "Picks for you" shown above a member's own Up Next.
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
    let who: [PickWho]?

    var id: String { title }

    enum CodingKeys: String, CodingKey {
        case title, network, rating, who
        case networkUrl = "network_url"
        case nNeighbors = "n_neighbors"
        case sharedActors = "shared_actors"
    }
}

struct PickWho: Codable, Hashable {
    let slug: String
    let name: String
}

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
    let isAdmin: Bool?

    enum CodingKeys: String, CodingKey {
        case authenticated, email, member
        case isAdmin = "is_admin"
    }
}

// /api/reporting — operator dashboard metrics.
struct Reporting: Codable {
    let generatedAt: String?
    let newShows: ReportWindow
    let editedShows: ReportWindow
    let archivedShows: ReportWindow
    let newMembers: ReportWindow
    let activeMembers: ActiveWindow
    let totals: ReportTotals
    let topNetworks: [NetworkCount]
    let topShared: [SharedTitle]

    enum CodingKeys: String, CodingKey {
        case totals
        case generatedAt = "generated_at"
        case newShows = "new_shows"
        case editedShows = "edited_shows"
        case archivedShows = "archived_shows"
        case newMembers = "new_members"
        case activeMembers = "active_members"
        case topNetworks = "top_networks"
        case topShared = "top_shared"
    }
}

struct ReportWindow: Codable {
    let day: Int
    let week: Int
    let month: Int
    let allTime: Int
    enum CodingKeys: String, CodingKey {
        case day, week, month
        case allTime = "all_time"
    }
}

struct ActiveWindow: Codable {
    let day: Int
    let week: Int
    let month: Int
}

struct ReportTotals: Codable {
    let members: Int
    let activeShows: Int
    let archivedShows: Int
    let watching: Int
    let waiting: Int
    let recommending: Int
    let next: Int
    enum CodingKeys: String, CodingKey {
        case members, watching, waiting, recommending, next
        case activeShows = "active_shows"
        case archivedShows = "archived_shows"
    }
}

struct NetworkCount: Codable, Identifiable {
    let network: String
    let cnt: Int
    var id: String { network }
}

struct SharedTitle: Codable, Identifiable {
    let title: String
    let members: Int
    var id: String { title }
}

// /api/admin-create-member result (success or {error}).
struct CreateMemberResult: Codable {
    let ok: Bool?
    let slug: String?
    let name: String?
    let url: String?
    let seeded: [String]?
    let error: String?
}

// /api/admin-signup-requests — pending /join requests for the operator.
struct SignupRequest: Codable, Identifiable {
    let id: Int
    let fullName: String
    let email: String?
    let phone: String?
    let source: String?
    let status: String
    let createdAt: String?
    let reviewedBy: String?
    let notes: String?
    let createdMemberSlug: String?

    enum CodingKeys: String, CodingKey {
        case id, email, phone, source, status, notes
        case fullName = "full_name"
        case createdAt = "created_at"
        case reviewedBy = "reviewed_by"
        case createdMemberSlug = "created_member_slug"
    }
}

struct SignupRequestsResponse: Codable { let requests: [SignupRequest] }

struct SignupActionResult: Codable {
    let ok: Bool?
    let error: String?
    let created: CreateMemberResult?
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
