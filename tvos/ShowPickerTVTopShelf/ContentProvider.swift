import Foundation
import TVServices

// The Top Shelf: while Show Picker Club sits in the top row of the Apple TV
// home screen and has focus, tvOS fills the band above the app row with what
// this returns — the club's Trending list, the same shelf Home leads with.
//
// Trending is public (/api/popular needs no session), so the shelf is the
// same signed in or out and the extension never touches the app's login; it
// has its own cookie store anyway. Choosing a poster opens that show's detail
// in the app through the showpickerclub:// scheme (Route.showLink in the app).
//
// Standalone on purpose: no ShowPickerCore, just the four fields the shelf
// draws. The system runs this in its own small process, on its own schedule.
final class ContentProvider: TVTopShelfContentProvider {

    // /api/popular pages the day's cached 50, so a longer shelf than Home's
    // ten costs the server nothing extra.
    private static let feed = URL(string: "https://showpicker.club/api/popular?limit=20")!

    override func loadTopShelfContent(completionHandler: @escaping (TVTopShelfContent?) -> Void) {
        var req = URLRequest(url: Self.feed)
        req.setValue("tvos", forHTTPHeaderField: "X-Client-Platform")
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            guard let data,
                  let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let shows = try? JSONDecoder().decode(Feed.self, from: data).shows else {
                // nil keeps whatever the system last showed (or the static
                // Top Shelf image) rather than blanking the shelf on a blip.
                completionHandler(nil)
                return
            }
            completionHandler(Self.content(for: shows))
        }.resume()
    }

    private static func content(for shows: [TrendingShow]) -> TVTopShelfContent? {
        // A poster shelf with blank tiles looks broken, so titles TMDB has no
        // artwork for sit this one out.
        let items = shows.compactMap(item(for:))
        guard !items.isEmpty else { return nil }
        let section = TVTopShelfItemCollection(items: items)
        section.title = "Trending at Show Picker Club"
        return TVTopShelfSectionedContent(sections: [section])
    }

    private static func item(for show: TrendingShow) -> TVTopShelfSectionedItem? {
        guard let poster = show.posterUrl.flatMap(URL.init(string:)),
              let link = showLink(show) else { return nil }
        let item = TVTopShelfSectionedItem(identifier: String(show.id))
        item.title = show.title
        item.imageShape = .poster
        item.setImageURL(poster, for: [.screenScale1x, .screenScale2x])
        item.displayAction = TVTopShelfAction(url: link)
        return item
    }

    // showpickerclub://show/<id>?title=<title> — the title rides along so the
    // detail screen has a header before its own fetch lands.
    private static func showLink(_ show: TrendingShow) -> URL? {
        var c = URLComponents()
        c.scheme = "showpickerclub"
        c.host = "show"
        c.path = "/\(show.id)"
        c.queryItems = [URLQueryItem(name: "title", value: show.title)]
        return c.url
    }
}

private struct Feed: Decodable { let shows: [TrendingShow] }

private struct TrendingShow: Decodable {
    let id: Int
    let title: String
    let posterUrl: String?

    enum CodingKeys: String, CodingKey {
        case id, title
        case posterUrl = "poster_url"
    }
}
