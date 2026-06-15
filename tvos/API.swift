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

    // iTunes Search API — public, no auth. Returns a tv.apple.com URL for
    // shows / movies in Apple's catalog. Opening it on tvOS lands on the
    // Apple TV app's show page, which has "Watch on <Service>" buttons that
    // deep-link into the right streaming service for that title.
    //
    // Coverage isn't universal: streaming-exclusive originals may not be in
    // Apple's catalog. Returns nil in that case and callers fall back to the
    // direct service URL.
    static func appleTVLookup(title: String) async -> URL? {
        let q = title.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? title
        for media in ["tvShow", "movie"] {
            let urlStr = "https://itunes.apple.com/search?term=\(q)&media=\(media)&country=us&limit=5"
            guard let url = URL(string: urlStr) else { continue }
            do {
                let (data, resp) = try await URLSession.shared.data(from: url)
                guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { continue }
                let parsed = try JSONDecoder().decode(ITunesSearchResponse.self, from: data)
                if let urlString = bestApple(match: title, in: parsed.results),
                   let u = URL(string: urlString) {
                    return u
                }
            } catch {
                continue
            }
        }
        return nil
    }

    private static func bestApple(match title: String, in results: [ITunesResult]) -> String? {
        let lower = title.lowercased()
        // Prefer exact-name match.
        if let hit = results.first(where: { ($0.trackName ?? $0.collectionName ?? "").lowercased() == lower }) {
            return hit.trackViewUrl ?? hit.collectionViewUrl
        }
        // Fall back to substring match either direction.
        if let hit = results.first(where: {
            let name = ($0.trackName ?? $0.collectionName ?? "").lowercased()
            return !name.isEmpty && (name.contains(lower) || lower.contains(name))
        }) {
            return hit.trackViewUrl ?? hit.collectionViewUrl
        }
        return nil
    }
}

struct ITunesSearchResponse: Codable {
    let resultCount: Int
    let results: [ITunesResult]
}

struct ITunesResult: Codable {
    let trackName: String?
    let collectionName: String?
    let trackViewUrl: String?
    let collectionViewUrl: String?
    let wrapperType: String?
    let kind: String?
}
