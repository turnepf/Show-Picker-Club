import SwiftUI

// Fetches the full show row + cast by id, so the same screen works whether
// you arrived from a member's list or the popular shelf. Shows the passed-in
// title/network/rating instantly, then fills in genres, notes, recommender,
// dates, cast, and the real watch URL once loaded.
struct ShowDetailView: View {
    let id: Int?
    let initialTitle: String
    let initialNetwork: String?
    let initialRating: String?
    var initialPoster: String? = nil
    var initialNetworkUrl: String? = nil

    @EnvironmentObject private var auth: AuthStore
    @State private var show: Show?
    // My own copy of this title (active or archived), resolved on load so the
    // list chip and the actions target MY row — not the stranger's copy that
    // search may have opened by id.
    @State private var myCopy: Show?
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

    // My active copy of this title, if I have one on a list.
    private var mineActive: Show? {
        guard let m = myCopy, !m.isArchived else { return nil }
        return m
    }
    // My archived copy of this title, if I've shelved it.
    private var mineArchived: Show? {
        guard let m = myCopy, m.isArchived else { return nil }
        return m
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                HStack(alignment: .top, spacing: 50) {
                    // One big image on the left, shown whole (not cropped): the
                    // landscape backdrop when we have one, else the portrait
                    // poster. Display-only — no tap-to-enlarge.
                    VStack(alignment: .leading, spacing: 24) {
                        heroImage
                            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        // Description under the image, filling the space the tall
                        // info column would otherwise leave blank on the left.
                        if let ov = show?.overview, !ov.isEmpty {
                            Text(ov)
                                .font(.system(size: 24))
                                .foregroundColor(Theme.muted)
                                .frame(maxWidth: 720, alignment: .leading)
                        }
                    }

                    VStack(alignment: .leading, spacing: 22) {
                        Text(title)
                            .font(.system(size: 54, weight: .bold))
                            .foregroundColor(Theme.text)

                        // Network intentionally omitted here — it lives on the
                        // watch button below, so the screen names it once.
                        HStack(spacing: 24) {
                            if let rating, !rating.isEmpty {
                                Label(rating, systemImage: "star.fill").foregroundColor(.orange)
                            }
                            if let m = mineActive, let l = ShowList(rawValue: m.list) {
                                HStack(spacing: 8) {
                                    Circle().fill(Theme.listColor(m.list)).frame(width: 16, height: 16)
                                    Text("On \(l.title)").foregroundColor(Theme.text.opacity(0.7))
                                }
                            } else if mineArchived != nil {
                                HStack(spacing: 8) {
                                    Image(systemName: "archivebox.fill").foregroundColor(Theme.muted)
                                    Text("Archived").foregroundColor(Theme.text.opacity(0.7))
                                }
                            }
                            if let s = show, s.isMovie {
                                Text("Movie").foregroundColor(Theme.text.opacity(0.5))
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
                        trailerButton

                        // The list controls live right under the buttons so the
                        // whole screen fits without scrolling on the TV.
                        actionsSection
                    }
                    Spacer()
                }

                // Cast sits below the image/info block, under the description on
                // the left, with the creator/director grouped under it.
                if !cast.isEmpty || (show?.director.map { !$0.isEmpty } ?? false) {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Cast")
                            .font(.system(size: 30, weight: .semibold))
                            .foregroundColor(Theme.text)
                        if !cast.isEmpty {
                            Text(cast.prefix(10).map { $0.name }.joined(separator: ", "))
                                .font(.system(size: 24))
                                .foregroundColor(Theme.muted)
                        }
                        if let s = show, let d = s.director, !d.isEmpty {
                            Text("\(s.directorLabel): \(d)")
                                .font(.system(size: 24))
                                .foregroundColor(Theme.muted)
                        }
                    }
                }
            }
            .padding(60)
        }
        .background(Theme.background.ignoresSafeArea())
        .task { await load() }
    }

    // Add-to-my-list (when signed in and it isn't already mine) or move-between-
    // lists (when it's my own show). Mirrors the iOS detail actions; editing,
    // sharing, and the calendar feed stay off the TV.
    // The four list chips ARE the move/add control: select one to move an
    // active copy to that list, restore an archived one, or add the show if I
    // don't have it. A checkmark marks the list it's currently on. Archive
    // stays as a separate action for a copy I actively have.
    @ViewBuilder private var actionsSection: some View {
        if auth.memberSlug != nil, (show != nil || id == nil) {
            let cur = mineActive.flatMap { ShowList(rawValue: $0.list) }
            VStack(alignment: .leading, spacing: 14) {
                Text("My Lists")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundColor(Theme.text)
                // Four list chips on one row, each sized to its own label so the
                // name never wraps. A colored dot + always-white label keeps the
                // name legible without focus; we don't .tint (that painted the
                // fill the same color as the text, hiding it until focus).
                HStack(spacing: 16) {
                    ForEach(ShowList.allCases) { l in
                        Button { Task { await chipTap(l) } } label: {
                            HStack(spacing: 10) {
                                Circle().fill(Theme.listColor(l.rawValue)).frame(width: 16, height: 16)
                                Text(l.title).foregroundColor(Theme.text)
                                if cur == l {
                                    Image(systemName: "checkmark")
                                        .foregroundColor(Theme.listColor(l.rawValue))
                                }
                            }
                            .font(.system(size: 24, weight: .semibold))
                            .lineLimit(1)
                            .fixedSize()
                        }
                        .buttonStyle(.bordered)
                        .disabled(working)
                    }
                }
                // Archive on its own row so the list row isn't crowded and the
                // focused button has room to scale up.
                if let m = mineActive {
                    Button(role: .destructive) { Task { await archive(m.id) } } label: {
                        Label("Archive", systemImage: "archivebox")
                            .font(.system(size: 24, weight: .semibold))
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .buttonStyle(.bordered)
                    .disabled(working)
                }
                if mineArchived != nil {
                    Text("Archived — pick a list to add it back")
                        .font(.system(size: 22))
                        .foregroundColor(Theme.muted)
                }
                if let actionMessage {
                    Text(actionMessage)
                        .font(.system(size: 22))
                        .foregroundColor(Theme.muted)
                }
            }
        }
    }

    private func chipTap(_ list: ShowList) async {
        if let m = mineActive {
            if m.list == list.rawValue { return }
            await moveTo(list, id: m.id)
        } else if let m = mineArchived {
            await restore(list, id: m.id)
        } else {
            await addToMyList(list)
        }
    }

    private func addToMyList(_ list: ShowList) async {
        // Works from a loaded show or a recommendation (no `show` yet).
        let addTitle = show?.title ?? initialTitle
        working = true
        defer { working = false }
        do {
            try await API.addShow(title: addTitle,
                                  network: show?.network ?? initialNetwork,
                                  networkUrl: show?.networkUrl ?? initialNetworkUrl,
                                  list: list.rawValue,
                                  movie: show?.isMovie ?? false,
                                  fullSeries: show?.isFullSeries ?? false)
            actionMessage = "Added “\(addTitle)” to your \(list.title) list."
            await refreshMyCopy()
        } catch API.APIError.badResponse(409) {
            // Already have it (maybe archived) — reconcile so the right
            // controls appear.
            await refreshMyCopy()
            actionMessage = mineArchived != nil
                ? "“\(addTitle)” is archived — pick a list to add it back."
                : "“\(addTitle)” is already on one of your lists."
        } catch API.APIError.badResponse(401) {
            actionMessage = "You're logged out — sign in again from the Account tab."
        } catch {
            actionMessage = "Couldn't add it. Please try again."
        }
    }

    private func moveTo(_ list: ShowList, id: Int) async {
        working = true
        defer { working = false }
        do {
            try await API.moveShow(id: id, to: list.rawValue)
            actionMessage = "Moved to \(list.title)."
            await refreshMyCopy()
        } catch API.APIError.badResponse(401) {
            actionMessage = "You're logged out — sign in again from the Account tab."
        } catch {
            actionMessage = "Couldn't move it. Please try again."
        }
    }

    private func archive(_ id: Int) async {
        working = true
        defer { working = false }
        do {
            try await API.archiveShow(id: id)
            actionMessage = "Archived."
            await refreshMyCopy()
        } catch API.APIError.badResponse(401) {
            actionMessage = "You're logged out — sign in again from the Account tab."
        } catch {
            actionMessage = "Couldn't archive it. Please try again."
        }
    }

    private func restore(_ list: ShowList, id: Int) async {
        working = true
        defer { working = false }
        do {
            try await API.restoreShow(id: id, to: list.rawValue)
            actionMessage = "Added back to \(list.title)."
            await refreshMyCopy()
        } catch API.APIError.badResponse(401) {
            actionMessage = "You're logged out — sign in again from the Account tab."
        } catch {
            actionMessage = "Couldn't restore it. Please try again."
        }
    }

    // Find my own row for this title (active or archived) so the actions and
    // list chip reflect MY copy, regardless of whose copy opened the screen.
    private func refreshMyCopy() async {
        guard let slug = auth.memberSlug else { myCopy = nil; return }
        let t = (show?.title ?? initialTitle).lowercased()
        let mine = (try? await API.myShows(slug: slug, includeArchived: true)) ?? []
        myCopy = mine.first { $0.title.lowercased() == t }
    }

    // The big left-hand image: the landscape backdrop shown whole (scaledToFit,
    // never cropped) when we have one, otherwise the portrait poster / tile.
    @ViewBuilder private var heroImage: some View {
        if let b = show?.backdropUrl, !b.isEmpty, let url = URL(string: b) {
            AsyncImage(url: url) { phase in
                if let img = phase.image {
                    img.resizable().scaledToFit()
                } else {
                    Rectangle().fill(Theme.background)
                }
            }
            .frame(width: 720, height: 405)
        } else {
            detailPoster
                .frame(width: 300, height: 450)
        }
    }

    // Portrait poster when we have one; otherwise a gradient tile with the
    // title so un-enriched shows still read clearly.
    @ViewBuilder private var detailPoster: some View {
        if let p = (show?.posterUrl ?? initialPoster), let url = URL(string: p) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    posterFallback
                }
            }
        } else {
            posterFallback
        }
    }

    private var posterFallback: some View {
        LinearGradient(
            colors: [Theme.tileColor(for: title), Theme.tileColor(for: title).opacity(0.78)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
        .overlay(
            Text(title)
                .font(.system(size: 36, weight: .bold))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .minimumScaleFactor(0.5)
                .padding(24)
        )
    }

    @ViewBuilder private func metaRows(_ s: Show) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let by = s.recommendedBy, !by.isEmpty {
                Text("Recommended by \(by)").foregroundColor(Theme.text.opacity(0.7))
            }
            if let dates = seasonLine(s) {
                Text(dates).foregroundColor(Theme.text.opacity(0.7))
            }
            if let w = s.watchingWith, !w.isEmpty {
                Text("Watching with \(w)").foregroundColor(Theme.text.opacity(0.7))
            }
            if let series = s.seriesText {
                Text(series).foregroundColor(Theme.text.opacity(0.7))
            }
            if let extra = extraMetaLine(s) {
                Text(extra).foregroundColor(Theme.text.opacity(0.7))
            }
            if let notes = s.notes, !notes.isEmpty {
                Text(notes).italic().foregroundColor(Theme.muted)
            }
            // Overview now lives under the hero image on the left, so it isn't
            // repeated here.
        }
        .font(.system(size: 24))
    }

    // "2026 · 1h 52m · TV-MA" — the catalog facts on one line. The audience
    // score isn't repeated here; the star Label by the title already shows it.
    private func extraMetaLine(_ s: Show) -> String? {
        var parts: [String] = []
        if let y = s.releaseYear { parts.append(String(y)) }
        if let rt = s.runtimeText { parts.append(rt) }
        if let cr = s.contentRating, !cr.isEmpty { parts.append(cr) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // "Next episode: 6/29" — the same M/D formatting the iOS rows use, instead
    // of raw ISO dates.
    private func seasonLine(_ s: Show) -> String? {
        // Season count now lives in the combined series line (seriesText).
        guard let r = s.nextUpRange else { return nil }
        return "Next episode: \(r)"
    }

    @ViewBuilder private var watchButton: some View {
        if let s = show, s.hasRealUrl, let urlStr = s.networkUrl, let url = URL(string: urlStr) {
            Button {
                openWatch(serviceUrl: url)
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
        } else if let s = show, let wl = s.whereToWatchURL {
            // No deep link — the TMDB/JustWatch "where to watch" page lists the
            // services carrying it.
            Button { openURL(wl) } label: {
                Label("Where to watch", systemImage: "magnifyingglass")
                    .font(.system(size: 26, weight: .semibold))
                    .padding(.vertical, 8)
            }
            .padding(.top, 12)
        } else if show != nil {
            Text("No direct link yet")
                .font(.system(size: 22))
                .foregroundColor(Theme.muted)
                .padding(.top, 12)
        }
    }

    @ViewBuilder private var trailerButton: some View {
        if let key = show?.trailerKey, !key.isEmpty {
            Button { openTrailer(key: key) } label: {
                Label("Trailer", systemImage: "play.rectangle.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .padding(.vertical, 8)
            }
        }
    }

    // tvOS has no web browser, so a trailer can only open in the YouTube app.
    // Try the app's URL scheme first (lands right on the video), then the https
    // universal link. Both require YouTube to be installed on the Apple TV — if
    // it isn't, neither opens (openURL just reports not-accepted and nothing
    // happens), which is why the button looked dead without it.
    private func openTrailer(key: String) {
        let candidates = [
            "youtube://watch?v=\(key)",
            "https://www.youtube.com/watch?v=\(key)",
        ].compactMap { URL(string: $0) }
        openFirstAvailable(candidates)
    }

    private func openFirstAvailable(_ urls: [URL]) {
        guard let first = urls.first else { return }
        openURL(first) { accepted in
            if !accepted { openFirstAvailable(Array(urls.dropFirst())) }
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
        // "Watch on X" matches the wording on web/iOS/watch — people didn't
        // realize the network name was the way to the show. When we can't
        // deep-link (just opening the service app), stay honest.
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

    // Try the best target; if the device can't open it (custom scheme not
    // registered, app hand-off declined), fall back to the universal https URL,
    // which on a real device can still hand off to the installed app.
    private func openWatch(serviceUrl: URL) {
        let primary = chooseTarget(serviceUrl: serviceUrl)
        openURL(primary) { ok in
            if ok { openFailed = false; return }
            if primary.absoluteString != serviceUrl.absoluteString {
                openURL(serviceUrl) { ok2 in openFailed = !ok2 }
            } else {
                openFailed = true
            }
        }
    }

    // Per-service URL rewriter. For most services on tvOS, the plain https
    // universal link doesn't even *open* the streaming app — openURL returns
    // accepted=false. Their own custom URL scheme launches the app instead
    // (no show-level deep link, but at least the app is up). Mapped per
    // service based on on-device tests.
    private func deepLinkURL(for url: URL) -> URL {
        let lower = url.absoluteString.lowercased()

        if lower.contains("watch.amazon.com") || lower.contains("primevideo.com") || lower.contains("amazon.com/gp/video") {
            // Bare scheme just launches Prime Video; the "/aiv/landing" path is
            // unreliable. If even this is declined we fall back to the https URL.
            if let u = URL(string: "aiv://") { return u }
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
        guard let id else {
            // Opened from a recommendation (no backing row yet) — show the
            // passed-in info and let the user pick a list to add it to.
            await refreshMyCopy()
            lookedUp = true
            return
        }
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
            await refreshMyCopy()
            lookedUp = true
            return
        }

        async let appleURL = API.appleTVLookup(title: initialTitle)
        if let s = try? await detail { show = s }
        cast = (try? await actors) ?? []
        appleTVUrl = await appleURL
        await refreshMyCopy()
        lookedUp = true
    }
}
