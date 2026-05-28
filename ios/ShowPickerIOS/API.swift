import Foundation

// Async client for showpicker.club. Read endpoints are unauthed; write
// endpoints rely on the session cookie set by /auth/login — URLSession's
// default config persists cookies via HTTPCookieStorage automatically,
// so we don't manage cookies by hand.

enum API {
    static let baseString = "https://showpicker.club"

    enum APIError: Error { case badURL, badResponse(Int), badBody }

    // MARK: GET helpers

    private static func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadRevalidatingCacheData
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.badResponse(-1) }
        guard (200..<300).contains(http.statusCode) else { throw APIError.badResponse(http.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: Reads

    static func members() async throws -> [Member] {
        let r: MembersResponse = try await get("/api/members")
        return r.members
    }

    static func popular() async throws -> [PopularShow] {
        let r: PopularResponse = try await get("/api/popular")
        return r.shows
    }

    static func shows(member slug: String, includeArchived: Bool = false) async throws -> [Show] {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        var path = "/api/shows?member=\(enc)"
        if includeArchived { path += "&include_archived=1" }
        let r: ShowsResponse = try await get(path)
        return r.shows
    }

    static func showDetail(id: Int) async throws -> Show {
        let r: ShowResponse = try await get("/api/shows/\(id)")
        return r.show
    }

    static func actors(showId: Int) async throws -> [Actor] {
        let r: ActorsResponse = try await get("/api/shows/\(showId)/actors")
        return r.actors
    }

    static func checkAuth() async -> AuthCheckResponse {
        (try? await get("/auth/check")) ?? AuthCheckResponse(authenticated: false, email: nil, member: nil)
    }

    // MARK: Auth

    static func login(member slug: String, code: String) async throws -> LoginResponse {
        try await postJSON("/auth/login", body: ["code": code, "member": slug])
    }

    static func logout() async {
        guard let url = URL(string: baseString + "/auth/logout") else { return }
        _ = try? await URLSession.shared.data(for: URLRequest(url: url))
    }

    // MARK: Writes (require session cookie)

    @discardableResult
    static func addShow(memberSlug: String, title: String, network: String?, list: String,
                        notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                        watchingWith: String?) async throws -> Show {
        struct Wrapper: Decodable { let show: Show }
        let body: [String: Any?] = [
            "title": title,
            "network": network,
            "list": list,
            "notes": notes,
            "recommended_by": recommendedBy,
            "movie": movie ? 1 : 0,
            "full_series": fullSeries ? 1 : 0,
            "watching_with": watchingWith,
        ]
        let r: Wrapper = try await postJSON("/api/shows", body: body)
        return r.show
    }

    @discardableResult
    static func updateShow(id: Int, title: String, network: String?, list: String,
                           notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                           watchingWith: String?, archived: Bool) async throws -> Show {
        struct Wrapper: Decodable { let show: Show }
        let body: [String: Any?] = [
            "title": title,
            "network": network,
            "list": list,
            "notes": notes,
            "recommended_by": recommendedBy,
            "movie": movie ? 1 : 0,
            "full_series": fullSeries ? 1 : 0,
            "watching_with": watchingWith,
            "archived": archived ? 1 : 0,
        ]
        let r: Wrapper = try await putJSON("/api/shows/\(id)", body: body)
        return r.show
    }

    static func moveShow(id: Int, to list: String) async throws {
        struct Ack: Decodable {}
        let _: Ack? = try? await putJSON("/api/shows/\(id)/move", body: ["list": list])
    }

    static func archiveShow(id: Int) async throws {
        struct Ack: Decodable {}
        let _: Ack? = try? await putJSON("/api/shows/\(id)/archive", body: [:])
    }

    static func deleteShow(id: Int) async throws {
        guard let url = URL(string: baseString + "/api/shows/\(id)") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
    }

    static func suggest(to member: String, title: String, network: String?, notes: String?,
                        recommendedBy: String?, movie: Bool, fullSeries: Bool) async throws {
        let body: [String: Any?] = [
            "member": member,
            "title": title,
            "network": network,
            "notes": notes,
            "recommended_by": recommendedBy,
            "movie": movie ? 1 : 0,
            "full_series": fullSeries ? 1 : 0,
        ]
        struct Ack: Decodable {}
        let _: Ack? = try? await postJSON("/api/suggestions", body: body)
    }

    // MARK: Internal

    private static func postJSON<T: Decodable>(_ path: String, body: [String: Any?]) async throws -> T {
        try await sendJSON(method: "POST", path: path, body: body)
    }
    private static func putJSON<T: Decodable>(_ path: String, body: [String: Any?]) async throws -> T {
        try await sendJSON(method: "PUT", path: path, body: body)
    }
    private static func sendJSON<T: Decodable>(method: String, path: String, body: [String: Any?]) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Filter out nil values so JSON omits them.
        let compact = body.compactMapValues { $0 }
        req.httpBody = try JSONSerialization.data(withJSONObject: compact)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        // Some endpoints return {} on success; tolerate empty decoding.
        if data.isEmpty || data == Data("{}".utf8) {
            // If T expects something, this will fail — but the Ack patterns above use try?.
            return try JSONDecoder().decode(T.self, from: Data("{}".utf8))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
