import SwiftUI

// Fetches the full show row + cast by id, so the same screen works whether
// you arrived from a member's list or the popular shelf. Shows the passed-in
// title/network/rating instantly, then fills in genres, notes, recommender,
// dates, cast, and the real watch URL once loaded.
struct ShowDetailView: View {
    let id: Int
    let initialTitle: String
    let initialNetwork: String?
    let initialRating: String?

    @State private var show: Show?
    @State private var cast: [Actor] = []
    @State private var appleTVUrl: URL?
    @State private var openFailed = false
    @Environment(\.openURL) private var openURL

    private var title: String { show?.title ?? initialTitle }
    private var network: String? { show?.network ?? initialNetwork }
    private var rating: String? { show?.rating ?? initialRating }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                HStack(alignment: .top, spacing: 50) {
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Theme.tileColor(for: title))
                        .overlay(
                            VStack(spacing: 8) {
                                Text(title)
                                    .font(.system(size: 40, weight: .bold))
                                    .foregroundColor(.white)
                                    .multilineTextAlignment(.center)
                                if let network, !network.isEmpty {
                                    Text("on \(network)")
                                        .font(.system(size: 24, weight: .medium))
                                        .foregroundColor(.white.opacity(0.85))
                                }
                            }
                            .padding(24)
                            .minimumScaleFactor(0.5)
                        )
                        .frame(width: 420, height: 280)

                    VStack(alignment: .leading, spacing: 22) {
                        Text(title)
                            .font(.system(size: 54, weight: .bold))
                            .foregroundColor(Theme.ink)

                        HStack(spacing: 24) {
                            if let rating, !rating.isEmpty {
                                Label(rating, systemImage: "star.fill").foregroundColor(.orange)
                            }
                            if let network, !network.isEmpty {
                                Text(network).foregroundColor(Theme.ink.opacity(0.7))
                            }
                            if let s = show, s.isMovie {
                                Text("Movie").foregroundColor(Theme.ink.opacity(0.5))
                            }
                            if let s = show, s.isFullSeries {
                                Text("🎬 Complete")
                            }
                        }
                        .font(.system(size: 26))

                        if let s = show, !s.genreList.isEmpty {
                            Text(s.genreList.joined(separator: " · "))
                                .font(.system(size: 24))
                                .foregroundColor(Theme.muted)
                        }

                        if let s = show { metaRows(s) }

                        watchButton
                    }
                    Spacer()
                }

                if !cast.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Cast")
                            .font(.system(size: 30, weight: .semibold))
                            .foregroundColor(Theme.ink)
                        Text(cast.prefix(10).map { $0.name }.joined(separator: ", "))
                            .font(.system(size: 24))
                            .foregroundColor(Theme.muted)
                    }
                }
            }
            .padding(60)
        }
        .background(Theme.cream.ignoresSafeArea())
        .task { await load() }
    }

    @ViewBuilder private func metaRows(_ s: Show) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let by = s.recommendedBy, !by.isEmpty {
                Text("Recommended by \(by)").foregroundColor(Theme.ink.opacity(0.7))
            }
            if let dates = seasonDates(s) {
                Text(dates).foregroundColor(Theme.ink.opacity(0.7))
            }
            if let w = s.watchingWith, !w.isEmpty {
                Text("Watching with \(w)").foregroundColor(Theme.ink.opacity(0.7))
            }
            if let notes = s.notes, !notes.isEmpty {
                Text(notes).italic().foregroundColor(Theme.muted)
            }
        }
        .font(.system(size: 24))
    }

    private func seasonDates(_ s: Show) -> String? {
        let start = s.nextSeasonDate, end = s.seasonEndDate
        if let start, !start.isEmpty, let end, !end.isEmpty { return "Next up: \(start) – \(end)" }
        if let start, !start.isEmpty { return "Next up: \(start)" }
        if let end, !end.isEmpty { return "Through \(end)" }
        return nil
    }

    @ViewBuilder private var watchButton: some View {
        if let s = show, s.hasRealUrl, let urlStr = s.networkUrl, let url = URL(string: urlStr) {
            Button {
                let target = chooseTarget(serviceUrl: url)
                openURL(target) { accepted in
                    openFailed = !accepted
                }
            } label: {
                Label(buttonLabel, systemImage: "play.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .padding(.vertical, 8)
            }
            .padding(.top, 12)

            if openFailed {
                Text("Couldn't open \(network ?? "the streaming") app on this device — open it directly to find the show.")
                    .font(.system(size: 20))
                    .foregroundColor(Theme.muted)
            }
        } else if show != nil {
            Text("No direct link yet")
                .font(.system(size: 22))
                .foregroundColor(Theme.muted)
                .padding(.top, 12)
        }
    }

    // Networks where the streaming service's tvOS app honors deep links to
    // a specific show via the plain https URL we already have.
    private static let deepLinksToShow: Set<String> = [
        "HBO Max",
        "Apple TV+",
    ]

    // True when we can land the user on the actual show page — either the
    // service deep-links directly, or we have an Apple TV app URL to route
    // through (it shows the show page with a "Watch on <Service>" button).
    private var canDeepLink: Bool {
        Self.deepLinksToShow.contains(network ?? "") || appleTVUrl != nil
    }

    private var buttonLabel: String {
        let n = network ?? "Streaming"
        let verb = canDeepLink ? "Watch on" : "Open"
        return "\(verb) \(n)"
    }

    // Pick the best URL to open:
    //  1. Direct service URL if the service deep-links from its own https
    //     URL (HBO Max, Apple TV+) AND we actually have a show-page URL,
    //     not the HBO Max search fallback.
    //  2. Otherwise route through the Apple TV app's show page if we found
    //     one — extra hop, but lands on the show with a one-tap launch.
    //  3. Otherwise the service URL itself (which for HBO Max search at
    //     least opens HBO Max with the title pre-filled), or the per-
    //     service custom-scheme fallback.
    private func chooseTarget(serviceUrl: URL) -> URL {
        let isHBOSearch = show?.isHBOMaxSearchFallback == true
        if Self.deepLinksToShow.contains(network ?? "") && !isHBOSearch {
            return serviceUrl
        }
        if let apple = appleTVUrl {
            return apple
        }
        return isHBOSearch ? serviceUrl : deepLinkURL(for: serviceUrl)
    }

    // Per-service URL rewriter. For most services on tvOS, the plain https
    // universal link doesn't even *open* the streaming app — openURL returns
    // accepted=false. Their own custom URL scheme launches the app instead
    // (no show-level deep link, but at least the app is up). Mapped per
    // service based on on-device tests.
    private func deepLinkURL(for url: URL) -> URL {
        let lower = url.absoluteString.lowercased()

        if lower.contains("watch.amazon.com") || lower.contains("primevideo.com") || lower.contains("amazon.com/gp/video") {
            if let u = URL(string: "aiv://aiv/landing") { return u }
        }
        if lower.contains("paramountplus.com") || lower.contains("paramount.com") {
            if let u = URL(string: "paramountplus://") { return u }
        }
        if lower.contains("peacocktv.com") {
            if let u = URL(string: "peacocktv://") { return u }
        }
        if lower.contains("hulu.com") {
            if let u = URL(string: "hulu://") { return u }
        }
        if lower.contains("disneyplus.com") {
            if let u = URL(string: "disneyplus://") { return u }
        }

        return url
    }

    private func load() async {
        if let s = try? await API.showDetail(id: id) { show = s }
        cast = (try? await API.actors(showId: id)) ?? []
        // Pre-fetch the Apple TV app URL so the Watch button can route
        // through Apple's show page when the streaming service itself
        // doesn't deep-link. Falls through silently if no match.
        appleTVUrl = await API.appleTVLookup(title: initialTitle)
    }
}
