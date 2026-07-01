import Foundation
import ShowPickerCore

// Minimal read client for the watch. Reads are public, so all we need is the
// member slug; the cookie is attached when present for future write support.
// Advertises X-Client-Platform: watchos for the reporting dashboard.
enum WatchAPI {
    static let base = "https://showpicker.club"
    static let platform = "watchos"

    enum APIError: Error { case badURL, badResponse(Int) }

    static func shows(member slug: String, cookie: String?) async throws -> [Show] {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        let r: ShowsResponse = try await get("/api/shows?member=\(enc)", cookie: cookie)
        return r.shows
    }

    static func showDetail(id: Int, cookie: String?) async throws -> Show {
        let r: ShowResponse = try await get("/api/shows/\(id)", cookie: cookie)
        return r.show
    }

    static func actors(showId: Int, cookie: String?) async throws -> [Actor] {
        let r: ActorsResponse = try await get("/api/shows/\(showId)/actors", cookie: cookie)
        return r.actors
    }

    private static func get<T: Decodable>(_ path: String, cookie: String?) async throws -> T {
        guard let url = URL(string: base + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpShouldHandleCookies = false
        if let cookie, !cookie.isEmpty { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
        req.setValue(platform, forHTTPHeaderField: "X-Client-Platform")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
