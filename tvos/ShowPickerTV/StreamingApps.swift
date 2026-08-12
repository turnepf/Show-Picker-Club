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
