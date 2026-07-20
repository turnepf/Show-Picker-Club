import Foundation

// Minimal API client for the Share Extension. Uses the session cookie
// written by the main app into the shared App Group container.
enum ShareAPI {
    private static let base = "https://showpicker.club"

    enum APIError: Error {
        case notLoggedIn, encodingFailed, badResponse(Int)
        // 409 from POST /api/shows — already on a list, or archived (server
        // dedupes against the canonical title, so this fires even when the
        // typed title is a near-match).
        case duplicate(list: String?, archived: Bool)
    }

    static func addShow(
        memberSlug: String,
        title: String,
        network: String?,
        list: String,
        notes: String?,
        movie: Bool
    ) async throws {
        guard let cookie = SharedSession.cookieHeader else { throw APIError.notLoggedIn }
        guard let url = URL(string: "\(base)/api/shows") else { throw APIError.encodingFailed }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(cookie,             forHTTPHeaderField: "Cookie")

        var body: [String: Any] = ["title": title, "list": list, "movie": movie ? 1 : 0]
        if let network { body["network"] = network }
        if let notes   { body["notes"]   = notes   }

        req.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if status == 401 { throw APIError.notLoggedIn }
            if status == 409 {
                struct ErrBody: Decodable { let error: String?; let list: String? }
                let b = try? JSONDecoder().decode(ErrBody.self, from: data)
                throw APIError.duplicate(list: b?.list, archived: b?.error == "exists_archived")
            }
            throw APIError.badResponse(status)
        }
    }
}
