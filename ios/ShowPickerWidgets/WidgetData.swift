import Foundation
import ShowPickerCore

// Data layer for the home-screen widgets. Widgets run in their own process:
// public reads (Trending) hit the API cookie-less; member reads (Upcoming)
// attach the session cookie the app parks in the shared App Group via
// SharedSession (the same bridge the Share Extension uses).
//
// Poster art must be fetched here in the provider — widget views render from a
// static snapshot and can't load images themselves — so each entry carries
// small poster thumbnails as raw Data.

// One show as a widget renders it, art included.
struct WidgetShow: Identifiable, Hashable {
    let id: Int
    let title: String
    let network: String?
    let rating: String?
    // Trending: "Watching: Patrick, Whitt". Upcoming: unused.
    let membersText: String?
    // Upcoming: premiere day of the next season. Trending: unused.
    let premiereDate: Date?
    let posterData: Data?

    // Tapping any widget row opens this show's card in the app — the app's
    // universal-link routing recognizes /show/<id> (title rides along so the
    // card has something to draw before its own fetch lands).
    var deepLink: URL? {
        var comps = URLComponents(string: "https://showpicker.club/show/\(id)")
        comps?.queryItems = [URLQueryItem(name: "title", value: title)]
        return comps?.url
    }
}

enum WidgetData {
    // MARK: Trending (/api/popular — public)

    private struct PopularRow: Decodable {
        let id: Int
        let title: String
        let network: String?
        let rating: String?
        let members: [String]?
        let posterUrl: String?
        enum CodingKeys: String, CodingKey {
            case id, title, network, rating, members
            case posterUrl = "poster_url"
        }
    }
    private struct PopularResponse: Decodable { let shows: [PopularRow] }

    static func trending(limit: Int) async -> [WidgetShow] {
        guard let rows: PopularResponse = await getJSON(path: "/api/popular") else { return [] }
        var out: [WidgetShow] = []
        for row in rows.shows.prefix(limit) {
            let members = row.members.flatMap { $0.isEmpty ? nil : "Watching: " + $0.joined(separator: ", ") }
            out.append(WidgetShow(id: row.id, title: row.title, network: row.network,
                                  rating: row.rating, membersText: members,
                                  premiereDate: nil,
                                  posterData: await poster(row.posterUrl)))
        }
        return out
    }

    // MARK: Upcoming premieres (member's Watching + Awaiting; session required)

    // Sorted soonest-first, today onwards. Empty when logged out, when nothing
    // is scheduled, or when the fetch fails — the views tell those states
    // apart via `isSignedIn`.
    static func upcoming(limit: Int, on day: Date) async -> [WidgetShow] {
        guard let slug = SharedSession.memberSlug,
              let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let rows: ShowsResponse = await getJSON(path: "/api/shows?member=\(enc)",
                                                      cookie: SharedSession.cookieHeader)
        else { return [] }

        let cal = Calendar.current
        let today = cal.startOfDay(for: day)
        let scheduled = rows.shows.compactMap { s -> (Show, Date)? in
            guard !s.isArchived,
                  s.list == ShowList.watching.rawValue || s.list == ShowList.waiting.rawValue,
                  let d = s.nextSeasonDay, cal.startOfDay(for: d) >= today
            else { return nil }
            return (s, cal.startOfDay(for: d))
        }.sorted { a, b in
            if a.1 != b.1 { return a.1 < b.1 }
            return (Double(a.0.rating ?? "0") ?? 0) > (Double(b.0.rating ?? "0") ?? 0)
        }

        var out: [WidgetShow] = []
        for (show, date) in scheduled.prefix(limit) {
            out.append(WidgetShow(id: show.id, title: show.title, network: show.network,
                                  rating: show.rating, membersText: nil,
                                  premiereDate: date,
                                  posterData: await poster(show.posterUrl)))
        }
        return out
    }

    static var isSignedIn: Bool { SharedSession.memberSlug != nil }

    // MARK: Plumbing

    private static func getJSON<T: Decodable>(path: String, cookie: String? = nil) async -> T? {
        guard let url = URL(string: "https://showpicker.club" + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpShouldHandleCookies = false
        if let cookie, !cookie.isEmpty { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
        req.setValue("ios", forHTTPHeaderField: "X-Client-Platform")
        req.cachePolicy = .reloadRevalidatingCacheData
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode)
        else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    // Poster thumbnails. Widgets live under a tight memory ceiling, so cap the
    // download and skip anything suspiciously large rather than risk a kill.
    private static let posterByteCap = 600_000

    private static func poster(_ urlString: String?) async -> Data? {
        guard let s = urlString, !s.isEmpty, let url = URL(string: s) else { return nil }
        var req = URLRequest(url: url)
        req.cachePolicy = .returnCacheDataElseLoad
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              data.count <= posterByteCap
        else { return nil }
        return data
    }

    // MARK: Date labels (mirrors the watch complication's formatting)

    // "Jul 24" — month + day, no year.
    static func dayLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f.string(from: date)
    }

    // "Today" / "Tomorrow" / "in 3 days" relative to the entry's day.
    static func relative(_ premiere: Date, from now: Date) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day],
                                      from: cal.startOfDay(for: now),
                                      to: cal.startOfDay(for: premiere)).day ?? 0
        switch days {
        case ..<0:  return "premiered"
        case 0:     return "Today"
        case 1:     return "Tomorrow"
        default:    return "in \(days) days"
        }
    }
}
