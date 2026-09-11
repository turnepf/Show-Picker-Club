import Foundation

// The tvOS custom URL schemes for each streaming service, in the order the
// Watch button tries them.
//
// This is the single source of truth: ShowDetailView's Watch button and the
// operator-only Streaming Link Check screen both read it, so what the check
// reports is exactly what a member's tap will do. Adding a candidate here
// changes both at once.
//
// Why schemes at all: tvOS can't resolve universal links into third-party
// apps — Apple's model is app-to-app linking only — so a plain https URL has
// no general mechanism to reach another app. A registered custom scheme is
// the only cross-app route available to us. The two exceptions are HBO Max
// and Apple TV+, whose tvOS apps do handle their own https URLs and land on
// the actual show; those are listed in ShowDetailView.deepLinksToShow and
// deliberately have no entry here.
//
// Several services carry more than one candidate because these apps get
// renamed and it's the *old* scheme that stays registered — Paramount+ still
// ships as com.cbsvideo.app and MGM+ as com.epix.epixnow. Order is
// current-name-first; openWatch falls through on refusal, so a rename
// degrades to the next candidate instead of to a dead button.
enum StreamingApps {

    struct Service: Identifiable, Hashable {
        var id: String { name }
        let name: String
        // Lowercased substrings that identify this service's stored web URL.
        let urlMarkers: [String]
        // Scheme names without the "://", best first.
        let schemes: [String]
        // What the on-device audit found, for the check screen to show
        // alongside a fresh result. nil where we've never had a reading.
        let lastKnown: String?
    }

    static let all: [Service] = [
        Service(name: "Netflix",
                urlMarkers: ["netflix.com"],
                schemes: ["nflx"],
                lastKnown: "Vendor removed deep links in a Sept 2025 update"),
        Service(name: "Hulu",
                urlMarkers: ["hulu.com"],
                schemes: ["hulu"],
                lastKnown: nil),
        Service(name: "Prime Video",
                urlMarkers: ["watch.amazon.com", "primevideo.com", "amazon.com/gp/video"],
                schemes: ["aiv", "primevideo"],
                lastKnown: nil),
        Service(name: "Paramount+",
                urlMarkers: ["paramountplus.com", "paramount.com"],
                schemes: ["paramountplus", "cbsaa"],
                lastKnown: "Reported broken since Nov 2023"),
        Service(name: "Peacock",
                urlMarkers: ["peacocktv.com"],
                schemes: ["peacocktv"],
                lastKnown: "Opened the app 8/12/2026"),
        Service(name: "Disney+",
                urlMarkers: ["disneyplus.com"],
                schemes: ["disneyplus"],
                lastKnown: "Opened the app 8/12/2026"),
        Service(name: "MGM+",
                urlMarkers: ["mgmplus.com"],
                schemes: ["mgmplus", "epixnow", "epix"],
                lastKnown: nil),
        Service(name: "Starz",
                urlMarkers: ["starz.com"],
                schemes: ["starz", "starzplay"],
                lastKnown: nil),
    ]

    // MARK: Show-level links
    //
    // The rows above answer "does this app open at all". They can't answer the
    // question that actually matters to a member — "does it open ON the show"
    // — because a bare `scheme://` has nowhere to put a show id.
    //
    // Each sample below is a real title on that service with the real
    // network_url the club stored for it, so a green row here means a member's
    // Watch button on that service would land them on the show. Two kinds of
    // candidate get tried:
    //
    //  - `https`, which is what the Watch button already sends. Known to work
    //    for HBO Max and Apple TV+ (verified on device 2026-08-12), and those
    //    two rows double as the control: if they fail, the device or the build
    //    is wrong, not the vendor.
    //  - `scheme + path`, which is unproven everywhere. tvOS gives us no way to
    //    ask whether an app parses a path, so the only way to find out is to
    //    press it on a real Apple TV. A red row is a recorded fact, not a bug —
    //    that is what this screen is for.
    //
    // Samples rot: a title leaves a service and its row starts failing for a
    // reason that has nothing to do with linking. When a row that used to pass
    // starts failing, check the title is still on the service before believing
    // the result — swapping in a fresh network_url from the library is the fix.
    struct ShowLink: Identifiable, Hashable {
        var id: String { service + title }
        let service: String
        let title: String
        let candidates: [Candidate]
        let note: String?
    }

    struct Candidate: Identifiable, Hashable {
        var id: String { url }
        // Short enough to read on a button; the full URL sits under the row.
        let label: String
        let url: String
    }

    static let showLinks: [ShowLink] = [
        ShowLink(service: "Apple TV+", title: "Ted Lasso",
                 candidates: [
                    Candidate(label: "https",
                              url: "https://tv.apple.com/us/show/ted-lasso/umc.cmc.vtoh0mn0xn7t3c643xqonfzy"),
                 ],
                 note: "Control — lands on the show, verified 8/12/2026"),
        ShowLink(service: "HBO Max", title: "The Pitt",
                 candidates: [
                    Candidate(label: "https",
                              url: "https://play.hbomax.com/show/e6e7bad9-d48d-4434-b334-7c651ffc4bdf"),
                 ],
                 note: "Control — lands on the show, verified 8/12/2026"),
        ShowLink(service: "Netflix", title: "The Gentlemen",
                 candidates: [
                    Candidate(label: "https",
                              url: "https://www.netflix.com/title/81437051"),
                    Candidate(label: "nflx:// + path",
                              url: "nflx://www.netflix.com/title/81437051"),
                 ],
                 note: "Vendor removed deep links in a Sept 2025 update"),
        ShowLink(service: "Hulu", title: "Schitt's Creek",
                 candidates: [
                    Candidate(label: "https",
                              url: "https://www.hulu.com/series/a2e7a946-9652-48a8-884b-3ea7ea4de273"),
                    Candidate(label: "hulu:// + path",
                              url: "hulu://series/a2e7a946-9652-48a8-884b-3ea7ea4de273"),
                 ],
                 note: nil),
        // Three rows because Watchmode stores Prime links in three different
        // shapes, and members have all three — amazon.com/gp/video/detail,
        // watch.amazon.com/detail?gti, and primevideo.com/detail. Which shapes
        // the app resolves decides what the Watch button can do, so they are
        // separate questions rather than a redundant retry of one.
        //
        // THE SHAPE IS THE VARIABLE, not the vendor (device test 9/10/2026):
        // watch.amazon.com/detail?gti= opened Prime Video ON the show. So Prime
        // deep links are alive on tvOS, and a member whose row carries that
        // shape could be landed on the show — see ShowDetailView.deepLinksToShow,
        // which still lists only HBO Max and Apple TV+.
        //
        // `aiv://aiv/resume?asin=` was tried here first and answered "can't
        // stream this show": resume is a PLAYBACK intent, and these ids are
        // series rather than playable episodes, so it fails whether or not the
        // link is good. Asking for the detail page is the right probe.
        ShowLink(service: "Prime Video", title: "Invincible",
                 candidates: [
                    Candidate(label: "https · amazon.com",
                              url: "https://www.amazon.com/gp/video/detail/B08WJQ3XP5/"),
                    Candidate(label: "aiv:// detail",
                              url: "aiv://aiv/detail?asin=B08WJQ3XP5"),
                 ],
                 note: "Amazon Original — availability is not the variable here"),
        ShowLink(service: "Prime Video", title: "Fleabag",
                 candidates: [
                    Candidate(label: "https · primevideo.com",
                              url: "https://www.primevideo.com/detail/0OB9NDUVQKFRSYRSCHT2A784TI"),
                 ],
                 note: "Second of Prime's three stored URL shapes"),
        ShowLink(service: "Prime Video", title: "Criminal Minds",
                 candidates: [
                    Candidate(label: "https · watch.amazon.com",
                              url: "https://watch.amazon.com/detail?gti=amzn1.dv.gti.672f095c-1391-4011-ae13-a4921ae540f8"),
                 ],
                 note: "Opened ON the show 9/10/2026 — the shape that works"),
        // The retail product page rather than a video-detail page, and a
        // quarter of the club's Prime rows are stored this way (110 rows on
        // 9/10/2026: 32 gti, 31 gp/video, 28 dp, 19 primevideo.com). Worth its
        // own row because "most Prime links can't reach the show" and "most
        // Prime links are the wrong shape" call for different repairs.
        ShowLink(service: "Prime Video", title: "Saltburn",
                 candidates: [
                    Candidate(label: "https · /dp/ retail",
                              url: "https://www.amazon.com/Saltburn-Barry-Keoghan/dp/B0CGHHFGBS"),
                 ],
                 note: "Fourth shape — Amazon's retail page, 25% of our Prime rows"),
        // Only the gti row reaches the show, and the question these ask is
        // WHICH PART of it matters: the watch.amazon.com host, or the
        // amzn1.dv.gti id? Every failing shape carries an ASIN we already
        // have, so if the host is the variable the fix is a rewrite we can do
        // ourselves over the stored rows — no vendor, no re-enrichment.
        // If the id is the variable, the ASINs are useless and the rows have
        // to be re-fetched for gti ids instead.
        //
        // Invincible in all three, so availability is held constant: it is an
        // Amazon Original, and its ASIN row (gp/video, above) already failed.
        ShowLink(service: "Prime Video", title: "Invincible · shape test",
                 candidates: [
                    Candidate(label: "host + ?gti=ASIN",
                              url: "https://watch.amazon.com/detail?gti=B08WJQ3XP5"),
                    Candidate(label: "host + ?asin=",
                              url: "https://watch.amazon.com/detail?asin=B08WJQ3XP5"),
                    Candidate(label: "host + /dp/",
                              url: "https://watch.amazon.com/dp/B08WJQ3XP5"),
                 ],
                 note: "If any is green AND lands on the show, every Amazon row is repairable"),
        ShowLink(service: "Disney+", title: "X-Men '97",
                 candidates: [
                    Candidate(label: "https",
                              url: "https://www.disneyplus.com/browse/entity-8dc91ed4-cdca-4fab-9723-d3d42f382d34"),
                    Candidate(label: "disneyplus:// + path",
                              url: "disneyplus://browse/entity-8dc91ed4-cdca-4fab-9723-d3d42f382d34"),
                 ],
                 note: "App opened to its home screen 8/12/2026"),
        ShowLink(service: "Peacock", title: "The Office",
                 candidates: [
                    Candidate(label: "https",
                              url: "https://www.peacocktv.com/watch/asset/tv/the-office/4902514835143843112"),
                    Candidate(label: "peacocktv:// + path",
                              url: "peacocktv://watch/asset/tv/the-office/4902514835143843112"),
                 ],
                 note: "App opened to its home screen 8/12/2026"),
        ShowLink(service: "Paramount+", title: "Lioness",
                 candidates: [
                    Candidate(label: "https",
                              url: "https://www.paramountplus.com/shows/lioness/"),
                    Candidate(label: "paramountplus:// + path",
                              url: "paramountplus://shows/lioness"),
                 ],
                 note: "Reported broken since Nov 2023"),
    ]

    // The service a stored network URL belongs to, or nil when we have no
    // scheme mapping for it (in which case the Watch button falls back to the
    // https URL and will most likely be refused).
    static func service(for url: URL) -> Service? {
        let lower = url.absoluteString.lowercased()
        return all.first { $0.urlMarkers.contains(where: lower.contains) }
    }

    // Scheme URLs to try for a stored network URL, best first. Empty when the
    // service has no mapping.
    static func schemes(for url: URL) -> [URL] {
        (service(for: url)?.schemes ?? []).compactMap { URL(string: "\($0)://") }
    }
}
