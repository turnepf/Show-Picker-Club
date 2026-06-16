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

    // Every active show across every member — backs cross-library search.
    static func allShows() async throws -> [AllShow] {
        let r: AllShowsResponse = try await get("/api/shows/all")
        return r.shows
    }

    // "Picks for you" for a member's own Up Next list.
    static func recommendations(member slug: String) async throws -> Recommendations {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        return try await get("/api/recommendations?member=\(enc)")
    }

    static func checkAuth() async -> AuthCheckResponse {
        (try? await get("/auth/check")) ?? AuthCheckResponse(authenticated: false, email: nil, member: nil, isAdmin: nil)
    }

    // Operator-only dashboard metrics (gated server-side on the session).
    static func reporting() async throws -> Reporting {
        try await get("/api/reporting")
    }

    // Pending /join signup requests (operator only).
    static func signupRequests() async throws -> [SignupRequest] {
        let r: SignupRequestsResponse = try await get("/api/admin-signup-requests")
        return r.requests
    }

    // Approve or reject a signup request; decodes the body either way so the
    // caller can show the server's message (e.g. a phone clash on approve).
    static func actOnSignupRequest(id: Int, action: String, notes: String? = nil) async throws -> SignupActionResult {
        guard let url = URL(string: baseString + "/api/admin-signup-requests") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["id": id, "action": action]
        if let n = notes { body["notes"] = n }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(SignupActionResult.self, from: data)
    }

    // URL-cleanup queue: titles still on a placeholder network URL (operator).
    static func urlCleanupQueue() async throws -> UrlCleanupResponse {
        try await postDecoding("/api/admin-url-cleanup", body: ["action": "list"])
    }

    // Save a real deep link for a queued title (propagates to every copy).
    static func saveShowUrl(id: Int, network: String, url: String) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup",
                               body: ["action": "save", "id": id, "network": network, "network_url": url])
    }

    // Rename a wrong/typo'd title across all copies and re-enrich it (operator).
    static func fixShowTitle(id: Int, newTitle: String) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup",
                               body: ["action": "fix_title", "id": id, "new_title": newTitle])
    }

    // POST + decode the body regardless of HTTP status, so admin tools can show
    // the server's error message instead of a bare status code.
    private static func postDecoding<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(T.self, from: data)
    }

    // Create a new member (operator only). Decodes the body on success or
    // failure so the caller can surface the server's error message.
    static func createMember(fullName: String, phone: String?, emails: String?) async throws -> CreateMemberResult {
        guard let url = URL(string: baseString + "/api/admin-create-member") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["full_name": fullName]
        if let p = phone, !p.isEmpty { body["phone"] = p }
        if let e = emails, !e.isEmpty { body["emails"] = e }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(CreateMemberResult.self, from: data)
    }

    // MARK: Auth

    static func loginWithEmail(email: String, code: String) async throws -> LoginResponse {
        try await postJSON("/auth/login", body: ["code": code, "email": email])
    }

    static func loginWithPhone(phone: String, code: String) async throws -> LoginResponse {
        try await postJSON("/auth/login", body: ["code": code, "phone": phone])
    }

    // Sign in with Apple: hand the verified identity token to the server, which
    // maps it to an existing member and sets the session cookie.
    static func loginWithApple(identityToken: String) async throws -> LoginResponse {
        try await postJSON("/auth/apple", body: ["identity_token": identityToken])
    }

    // Ask Twilio Verify to text a 6-digit OTP. Server replies 200 even for
    // unknown numbers (account-enumeration hardening), so a true result
    // doesn't prove the number is on file — it just means the request was
    // accepted.
    @discardableResult
    static func requestSmsCode(phone: String) async throws -> Bool {
        struct Ack: Decodable { let success: Bool? }
        let r: Ack = try await postJSON("/auth/request-code",
                                        body: ["phone": phone, "channel": "sms"])
        return r.success == true
    }

    // Ask the server to email a fresh 6-digit OTP. Server replies 200 even
    // for unknown emails (account-enumeration hardening), so a true result
    // doesn't prove the address is on file — it just means the request was
    // accepted.
    @discardableResult
    static func requestEmailCode(email: String) async throws -> Bool {
        struct Ack: Decodable { let success: Bool? }
        let r: Ack = try await postJSON("/auth/request-code",
                                        body: ["email": email, "channel": "email"])
        return r.success == true
    }

    static func logout() async {
        guard let url = URL(string: baseString + "/auth/logout") else { return }
        _ = try? await URLSession.shared.data(for: URLRequest(url: url))
    }

    // MARK: Writes (require session cookie)

    @discardableResult
    static func addShow(memberSlug: String, title: String, network: String?, networkUrl: String? = nil,
                        list: String, notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                        watchingWith: String?) async throws -> Show {
        struct Wrapper: Decodable { let show: Show }
        let body: [String: Any?] = [
            "title": title,
            "network": network,
            "network_url": networkUrl,
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

    // Send an existing show to another member's Up Next, carrying over its
    // enrichment (rating, network link, cast, movie/series flags). Returns the
    // outcome so the UI can speak to duplicates.
    @discardableResult
    static func shareShow(showId: Int, sourceMember: String, targetMember: String,
                          recommendedBy: String, notes: String?) async throws -> ShareOutcome {
        let body: [String: Any?] = [
            "show_id": showId,
            "source_member": sourceMember,
            "target_member": targetMember,
            "recommended_by": recommendedBy,
            "notes": notes,
        ]
        let r: ShareResponse = try await postJSON("/api/shows/share", body: body)
        if r.duplicate == true {
            return r.archived == true ? .duplicateArchived : .duplicate(list: r.list)
        }
        return .sent
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
