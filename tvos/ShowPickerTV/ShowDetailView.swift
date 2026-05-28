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
                let target = deepLinkURL(for: url)
                openURL(target) { accepted in
                    openFailed = !accepted
                }
            } label: {
                Label("Watch on \(network ?? "Streaming")", systemImage: "play.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .padding(.vertical, 8)
            }
            .padding(.top, 12)

            if openFailed {
                Text("Couldn't open the app on this device — try the \(network ?? "streaming") app directly.")
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

    // Per-service URL rewriter — many tvOS streaming apps don't honor https
    // universal links to the show, but do honor their own custom URL scheme.
    // We learn the right scheme one service at a time from on-device testing.
    private func deepLinkURL(for url: URL) -> URL {
        let s = url.absoluteString
        let lower = s.lowercased()

        // Netflix: https://www.netflix.com/title/<id> only opens the Netflix
        // app to home. nflx://www.netflix.com/title/<id> deep-links to the show.
        if lower.contains("netflix.com") {
            let t = s.replacingOccurrences(of: "https://www.netflix.com", with: "nflx://www.netflix.com")
                    .replacingOccurrences(of: "https://netflix.com",   with: "nflx://www.netflix.com")
            if let u = URL(string: t) { return u }
        }

        // Amazon Prime Video: tvOS app doesn't claim watch.amazon.com URLs.
        // Try Amazon Instant Video's custom scheme; falls back to https if
        // openURL rejects.
        if lower.contains("watch.amazon.com") || lower.contains("primevideo.com") || lower.contains("amazon.com/gp/video") {
            // Extract any gti or asin we can find and route through aiv://.
            // Worst case the Prime Video app just opens to its home — still
            // better than tvOS rejecting outright.
            if let u = URL(string: "aiv://aiv/landing") { return u }
        }

        // Paramount+: same pattern — try the custom scheme.
        if lower.contains("paramountplus.com") || lower.contains("paramount.com") {
            if let u = URL(string: "paramountplus://") { return u }
        }

        // Peacock: tvOS app opens from peacocktv.com universal links but
        // doesn't navigate to the show. Try the custom scheme.
        if lower.contains("peacocktv.com") {
            let t = s.replacingOccurrences(of: "https://www.peacocktv.com", with: "peacocktv://www.peacocktv.com")
                    .replacingOccurrences(of: "https://peacocktv.com",   with: "peacocktv://www.peacocktv.com")
            if let u = URL(string: t) { return u }
        }

        return url
    }

    private func load() async {
        if let s = try? await API.showDetail(id: id) { show = s }
        cast = (try? await API.actors(showId: id)) ?? []
    }
}
