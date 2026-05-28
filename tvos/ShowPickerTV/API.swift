import Foundation

// Thin async client over the public, view-only endpoints. No auth — browsing
// is open on showpicker.club, and editing stays on the phone.
enum API {
    static let baseString = "https://showpicker.club"

    enum APIError: Error { case badURL, badResponse }

    private static func get<T: Decodable>(_ path: String) async throws -> T {
        // Build from a raw string so query components (?member=…) survive —
        // URL.appendingPathComponent would percent-encode the "?".
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadRevalidatingCacheData
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    static func members() async throws -> [Member] {
        let r: MembersResponse = try await get("/api/members")
        return r.members
    }

    static func popular() async throws -> [PopularShow] {
        let r: PopularResponse = try await get("/api/popular")
        return r.shows
    }

    static func shows(member slug: String) async throws -> [Show] {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        let r: ShowsResponse = try await get("/api/shows?member=\(enc)")
        return r.shows
    }

    // Full row for one show (genres, notes, recommender, dates, URL) — but
    // not cast, which lives at a separate endpoint.
    static func showDetail(id: Int) async throws -> Show {
        let r: ShowResponse = try await get("/api/shows/\(id)")
        return r.show
    }

    static func actors(showId: Int) async throws -> [Actor] {
        let r: ActorsResponse = try await get("/api/shows/\(showId)/actors")
        return r.actors
    }
}
