import Foundation

// Thin async client over the showpicker.club API. Browsing is open; signing in
// (phone / email OTP) sets the session cookie that URLSession.shared persists
// automatically, so authenticated reads just work afterwards.
enum API {
    static let baseString = "https://showpicker.club"

    // Platform usage tracking: every request advertises the client so
    // /auth/check can stamp "tvos" onto the session for the reporting dashboard.
    static let platform = "tvos"

    enum APIError: Error { case badURL, badResponse(Int) }

    private static func get<T: Decodable>(_ path: String) async throws -> T {
        // Build from a raw string so query components (?member=…) survive —
        // URL.appendingPathComponent would percent-encode the "?".
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadRevalidatingCacheData
        req.setValue(platform, forHTTPHeaderField: "X-Client-Platform")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // Send a JSON body with the given method and decode the reply. Used by the
    // auth flow and the write actions (add / move).
    private static func sendJSON<T: Decodable>(_ path: String, method: String = "POST",
                                               body: [String: Any]) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(platform, forHTTPHeaderField: "X-Client-Platform")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func postJSON<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        try await sendJSON(path, method: "POST", body: body)
    }

    // MARK: Auth

    static func checkAuth() async -> AuthCheckResponse {
        (try? await get("/auth/check")) ?? AuthCheckResponse(authenticated: false, email: nil, member: nil, isAdmin: nil)
    }

    static func loginWithEmail(email: String, code: String) async throws -> LoginResponse {
        try await postJSON("/auth/login", body: ["code": code, "email": email])
    }

    static func loginWithPhone(phone: String, code: String) async throws -> LoginResponse {
        try await postJSON("/auth/login", body: ["code": code, "phone": phone])
    }

    // Server replies 200 even for unknown numbers/addresses (account-enumeration
    // hardening), so success only means the request was accepted.
    @discardableResult
    static func requestSmsCode(phone: String) async throws -> Bool {
        let r: Ack = try await postJSON("/auth/request-code", body: ["phone": phone, "channel": "sms"])
        return r.success == true
    }

    @discardableResult
    static func requestEmailCode(email: String) async throws -> Bool {
        let r: Ack = try await postJSON("/auth/request-code", body: ["email": email, "channel": "email"])
        return r.success == true
    }

    static func logout() async {
        guard let url = URL(string: baseString + "/auth/logout") else { return }
        var req = URLRequest(url: url)
        req.setValue(platform, forHTTPHeaderField: "X-Client-Platform")
        _ = try? await URLSession.shared.data(for: req)
    }

    // MARK: Writes (require the session cookie)

    // Add a show to the logged-in member's list. The server scopes the insert
    // to the session's member, so we don't pass a slug — this always lands on
    // *my* list. Used to copy a popular / another member's show onto your own.
    @discardableResult
    static func addShow(title: String, network: String?, networkUrl: String?,
                        list: String, movie: Bool, fullSeries: Bool) async throws -> Show {
        var body: [String: Any] = [
            "title": title,
            "list": list,
            "movie": movie ? 1 : 0,
            "full_series": fullSeries ? 1 : 0,
        ]
        if let network, !network.isEmpty { body["network"] = network }
        if let networkUrl, !networkUrl.isEmpty { body["network_url"] = networkUrl }
        let r: ShowResponse = try await sendJSON("/api/shows", method: "POST", body: body)
        return r.show
    }

    // Move one of my own shows to another list.
    static func moveShow(id: Int, to list: String) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await sendJSON("/api/shows/\(id)/move", method: "PUT", body: ["list": list])
    }

    static func members() async throws -> [Member] {
        let r: MembersResponse = try await get("/api/members")
        return r.members
    }

    static func popular() async throws -> [PopularShow] {
        let r: PopularResponse = try await get("/api/popular")
        return r.shows
    }

    // Every active show across all members — backs cross-library search. The
    // rows carry extra member columns the Show model simply ignores.
    static func allShows() async throws -> [Show] {
        let r: ShowsResponse = try await get("/api/shows/all")
        return r.shows
    }

    // "Picks for you" for a member's own Up Next. Returns empty picks for
    // seed-only members; callers can just check picks.isEmpty.
    static func recommendations(member slug: String) async throws -> Recommendations {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        return try await get("/api/recommendations?member=\(enc)")
    }

    static func shows(member slug: String) async throws -> [Show] {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        let r: ShowsResponse = try await get("/api/shows?member=\(enc)")
        return r.shows
    }

    // My own rows, optionally including archived ones — used by the detail
    // screen to find *my* copy of a show (so actions target my row, not the
    // stranger's copy that search may have surfaced by id).
    static func myShows(slug: String, includeArchived: Bool) async throws -> [Show] {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        let suffix = includeArchived ? "&include_archived=1" : ""
        let r: ShowsResponse = try await get("/api/shows?member=\(enc)\(suffix)")
        return r.shows
    }

    // Soft-archive one of my shows.
    static func archiveShow(id: Int) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await sendJSON("/api/shows/\(id)", method: "PUT", body: ["archived": 1])
    }

    // Restore an archived show and drop it onto a list in one call.
    static func restoreShow(id: Int, to list: String) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await sendJSON("/api/shows/\(id)", method: "PUT", body: ["archived": 0, "list": list])
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
