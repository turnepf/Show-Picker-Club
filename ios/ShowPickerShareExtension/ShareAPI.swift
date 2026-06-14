import Foundation

// Minimal API client for the Share Extension. Uses the session cookie
// written by the main app into the shared App Group container.
enum ShareAPI {
    private static let base = "https://showpicker.club"

    enum APIError: Error {
        case notLoggedIn, encodingFailed, badResponse(Int)
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

        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
    }
}
