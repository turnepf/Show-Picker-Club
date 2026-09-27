import Foundation
import ShowPickerCore
import UIKit

// Data layer for the home-screen widgets. Widgets run in their own process:
// public reads (Trending) hit the API cookie-less; member reads (Upcoming)
// attach the session cookie the app parks in the shared App Group via
// SharedSession (the same bridge the Share Extension uses).
//
// Poster art must be fetched here in the provider — widget views render from a
// static snapshot and can't load images themselves — so each entry carries
// small poster thumbnails as raw Data.

// One show as a widget renders it, art included. Codable because each
// successful fetch is snapshotted to the App Group (WidgetSnapshotCache) and
// replayed when a later refresh fails — an offline widget shows the last good
// rows instead of "Nothing trending yet" / "Nothing dated coming up".
struct WidgetShow: Identifiable, Hashable, Codable {
    let id: Int
    let title: String
    let network: String?
    let rating: String?
    // Trending: "Watching: Patrick, Quinn". Upcoming: unused.
    let membersText: String?
    // Upcoming: the show's next calendar day — a season premiere or a season
    // finale, whichever lands first. Trending: unused.
    let eventDate: Date?
    let eventKind: ShowCalendar.Kind?
    let posterData: Data?

    // "Premieres" / "Finale" — what the date on this row actually is.
    var eventLabel: String? { eventKind?.label }

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
        // The snapshot is keyed per limit because each widget family fetches
        // its own row count — a small widget's one-row snapshot shouldn't
        // starve a large widget of its six.
        let cacheKey = "trending-\(limit)"
        guard let rows: PopularResponse = await getJSON(path: "/api/popular") else {
            return WidgetSnapshotCache.load([WidgetShow].self, for: cacheKey) ?? []
        }
        var out: [WidgetShow] = []
        for row in rows.shows.prefix(limit) {
            let members = row.members.flatMap { $0.isEmpty ? nil : "Watching: " + $0.joined(separator: ", ") }
            out.append(WidgetShow(id: row.id, title: row.title, network: row.network,
                                  rating: row.rating, membersText: members,
                                  eventDate: nil, eventKind: nil,
                                  posterData: await poster(row.posterUrl)))
        }
        WidgetSnapshotCache.save(out, for: cacheKey)
        return out
    }

    // MARK: Upcoming calendar dates (member's Watching + Awaiting; session required)

    // The member's calendar, soonest first, today onwards — the same premieres
    // *and* season finales the in-app Calendar screen and the .ics feed carry
    // (`ShowCalendar.upcoming`), not premieres alone. Empty when logged out,
    // when nothing is dated, or when the fetch fails — the views tell those
    // states apart via `isSignedIn`.
    static func upcoming(limit: Int, on day: Date) async -> [WidgetShow] {
        guard let slug = SharedSession.memberSlug,
              let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return [] }

        // Keyed by slug (as well as limit) so a different member signing in on
        // this device can never be shown the previous member's calendar.
        let cacheKey = "upcoming-\(slug)-\(limit)"
        guard let rows: ShowsResponse = await getJSON(path: "/api/shows?member=\(enc)",
                                                      cookie: SharedSession.cookieHeader)
        else {
            // Offline: replay the last good snapshot, minus any date that has
            // passed since it was taken — a premiere from last week must not
            // sit on the home screen as "Today".
            let start = Calendar.current.startOfDay(for: day)
            let cached = WidgetSnapshotCache.load([WidgetShow].self, for: cacheKey) ?? []
            return cached.filter { ($0.eventDate ?? .distantPast) >= start }
        }

        var out: [WidgetShow] = []
        for item in ShowCalendar.upcoming(from: rows.shows, on: day).prefix(limit) {
            out.append(WidgetShow(id: item.show.id, title: item.show.title, network: item.show.network,
                                  rating: item.show.rating, membersText: nil,
                                  eventDate: item.date, eventKind: item.kind,
                                  posterData: await poster(item.show.posterUrl)))
        }
        WidgetSnapshotCache.save(out, for: cacheKey)
        return out
    }

    static var isSignedIn: Bool { SharedSession.memberSlug != nil }

    // Matches API.currentPlatform in the main app target — widgets run in
    // their own process but UIDevice still reflects the host device.
    private static let platform: String = {
        if ProcessInfo.processInfo.isMacCatalystApp { return "mac" }
        return UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    }()

    // MARK: Plumbing

    private static func getJSON<T: Decodable>(path: String, cookie: String? = nil) async -> T? {
        guard let url = URL(string: "https://showpicker.club" + path) else { return nil }
        var req = URLRequest(url: url)
        req.httpShouldHandleCookies = false
        if let cookie, !cookie.isEmpty { req.setValue(cookie, forHTTPHeaderField: "Cookie") }
        req.setValue(platform, forHTTPHeaderField: "X-Client-Platform")
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

    // MARK: Date labels

    // "Jul 24" — month + day, no year.
    static func dayLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f.string(from: date)
    }

    // "Today" / "Tomorrow" / "in 3 days" relative to the entry's day.
    static func relative(_ date: Date, from now: Date) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day],
                                      from: cal.startOfDay(for: now),
                                      to: cal.startOfDay(for: date)).day ?? 0
        switch days {
        case ..<0:  return "aired"
        case 0:     return "Today"
        case 1:     return "Tomorrow"
        default:    return "in \(days) days"
        }
    }
}
