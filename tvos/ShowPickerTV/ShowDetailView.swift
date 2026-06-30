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

    @EnvironmentObject private var auth: AuthStore
    @State private var show: Show?
    @State private var cast: [Actor] = []
    @State private var appleTVUrl: URL?
    @State private var lookedUp = false
    @State private var openFailed = false
    @State private var working = false
    @State private var actionMessage: String?
    @Environment(\.openURL) private var openURL

    private var title: String { show?.title ?? initialTitle }
    private var network: String? { show?.network ?? initialNetwork }
    private var rating: String? { show?.rating ?? initialRating }

    // Mine when the loaded show belongs to the signed-in member.
    private var isMine: Bool {
        guard let mine = auth.memberSlug, let s = show else { return false }
        return s.memberSlug == mine
    }
    // Signed in and viewing someone else's (or a popular) show → can copy it.
    private var canAddToMine: Bool {
        auth.memberSlug != nil && show != nil && !isMine
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                HStack(alignment: .top, spacing: 50) {
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Theme.tileColor(for: title))
                        .overlay(
                            Text(title)
                                .font(.system(size: 40, weight: .bold))
                                .foregroundColor(.white)
                                .multilineTextAlignment(.center)
                                .padding(24)
                                .minimumScaleFactor(0.5)
                        )
                        .frame(width: 420, height: 280)

                    VStack(alignment: .leading, spacing: 22) {
                        Text(title)
                            .font(.system(size: 54, weight: .bold))
                            .foregroundColor(Theme.ink)

                        // Network intentionally omitted here — it lives on the
                        // watch button below, so the screen names it once.
                        HStack(spacing: 24) {
                            if let rating, !rating.isEmpty {
                                Label(rating, systemImage: "star.fill").foregroundColor(.orange)
                            }
                            if let s = show, let l = ShowList(rawValue: s.list) {
                                HStack(spacing: 8) {
                                    Circle().fill(Theme.listColor(s.list)).frame(width: 16, height: 16)
                                    Text(l.title).foregroundColor(Theme.ink.opacity(0.7))
                                }
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

                actionsSection

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

    // Add-to-my-list (when signed in and it isn't already mine) or move-between-
    // lists (when it's my own show). Mirrors the iOS detail actions; editing,
    // sharing, and the calendar feed stay off the TV.
    @ViewBuilder private var actionsSection: some View {
        if let s = show, canAddToMine || isMine || actionMessage != nil {
            VStack(alignment: .leading, spacing: 14) {
                if canAddToMine {
                    Text("Add to my list")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundColor(Theme.ink)
                    HStack(spacing: 24) {
                        ForEach(ShowList.allCases) { l in
                            Button(l.title) { Task { await addToMyList(l) } }
                                .disabled(working)
                        }
                    }
                } else if isMine, let cur = ShowList(rawValue: s.list) {
                    Text("Move to")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundColor(Theme.ink)
                    HStack(spacing: 24) {
                        ForEach(ShowList.allCases.filter { $0 != cur }) { l in
                            Button(l.title) { Task { await moveTo(l) } }
                                .disabled(working)
                        }
                    }
                }

                if let actionMessage {
                    Text(actionMessage)
                        .font(.system(size: 22))
                        .foregroundColor(Theme.muted)
                }
            }
        }
    }

    private func addToMyList(_ list: ShowList) async {
        guard let s = show else { return }
        working = true
        defer { working = false }
        do {
            try await API.addShow(title: s.title, network: s.network, networkUrl: s.networkUrl,
                                  list: list.rawValue, movie: s.isMovie, fullSeries: s.isFullSeries)
            actionMessage = "Added “\(s.title)” to your \(list.title) list."
        } catch API.APIError.badResponse(409) {
            actionMessage = "“\(s.title)” is already on one of your lists."
        } catch {
            actionMessage = "Couldn't add it. Please try again."
        }
    }

    private func moveTo(_ list: ShowList) async {
        guard let s = show else { return }
        working = true
        defer { working = false }
        do {
            try await API.moveShow(id: s.id, to: list.rawValue)
            actionMessage = "Moved to \(list.title)."
            await load()   // refresh so the list chip reflects the new list
        } catch {
            actionMessage = "Couldn't move it. Please try again."
        }
    }

    @ViewBuilder private func metaRows(_ s: Show) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let by = s.recommendedBy, !by.isEmpty {
                Text("Recommended by \(by)").foregroundColor(Theme.ink.opacity(0.7))
            }
            if let dates = seasonLine(s) {
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

    // "Next up: 6/29 – 7/13 · 3 seasons" — the same M/D formatting and seasons
    // count the iOS rows use, instead of raw ISO dates.
    private func seasonLine(_ s: Show) -> String? {
        var parts: [String] = []
        if let r = s.nextUpRange { parts.append("Next up: \(r)") }
        if let seasons = s.seasonsText { parts.append(seasons) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private var watchButton: some View {
        if let s = show, s.hasRealUrl, let urlStr = s.networkUrl, let url = URL(string: urlStr) {
            Button {
                let target = chooseTarget(serviceUrl: url)
                openURL(target) { accepted in
                    openFailed = !accepted
                }
            } label: {
                HStack(spacing: 12) {
                    Label(buttonLabel, systemImage: "play.fill")
                        .font(.system(size: 30, weight: .semibold))
                    if !lookedUp {
                        // While the iTunes Search lookup is in flight we
                        // don't yet know whether to route through the
                        // Apple TV app or land on the service. Show a
                        // spinner so the button is honest about waiting.
                        ProgressView().scaleEffect(0.9)
                    }
                }
                .padding(.vertical, 8)
            }
            .disabled(!lookedUp)
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
        // HBO Max + Apple TV+ honor direct https URLs in their tvOS apps,
        // and HBO content rarely lives on Apple TV anyway — iTunes Search
        // for those just slows the Watch button down for no gain. Skip
        // the lookup entirely and enable the button immediately.
        let skipITunes = Self.deepLinksToShow.contains(network ?? "")

        async let detail = API.showDetail(id: id)
        async let actors = API.actors(showId: id)

        if skipITunes {
            if let s = try? await detail { show = s }
            cast = (try? await actors) ?? []
            lookedUp = true
            return
        }

        async let appleURL = API.appleTVLookup(title: initialTitle)
        if let s = try? await detail { show = s }
        cast = (try? await actors) ?? []
        appleTVUrl = await appleURL
        lookedUp = true
    }
}
