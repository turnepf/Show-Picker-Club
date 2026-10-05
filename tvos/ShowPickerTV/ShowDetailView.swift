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
    // Set once refreshMyCopy() has answered, so the "add it" hint never
    // flashes on a show that turns out to be mine.
    @State private var myCopyChecked = false
    @State private var cast: [Actor] = []
    @State private var openFailed = false
    @State private var working = false
    @State private var actionMessage: String?
    // Average/count always present once the show has a tmdb_id; `owner`
    // populates only when viewing a specific other member's copy. tvOS is
    // view-only for ratings — rate from iPhone/iPad.
    @State private var ratings: RatingsSummary?
    // Fellow group members with this title on their Watching list. Empty
    // unless I'm in a group with someone who's watching it.
    @State private var groupWatchers: [GroupWatcher] = []
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
                        // Description + cast under the image, filling the space the
                        // tall info column would otherwise leave blank on the left,
                        // so the whole screen fits without scrolling.
                        // Tagline above the synopsis, as on iOS — the pull
                        // quote, then the plot. Dimmer than the overview so the
                        // eye lands on the synopsis first at ten feet.
                        if let tl = show?.tagline, !tl.isEmpty {
                            Text(tl)
                                .font(.system(size: 24).italic())
                                .foregroundColor(Theme.muted.opacity(0.75))
                                .frame(maxWidth: 720, alignment: .leading)
                        }
                        if let ov = show?.overview, !ov.isEmpty {
                            Text(ov)
                                .font(.system(size: 24))
                                .foregroundColor(Theme.muted)
                                .frame(maxWidth: 720, alignment: .leading)
                        }
                        castSection
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

                        // Who else in my groups is watching this. It sits
                        // directly above the watch button, which is where
                        // this screen names the network.
                        groupWatchingLine
                        watchButton

                        // The list controls live right under the buttons so the
                        // whole screen fits without scrolling on the TV.
                        actionsSection
                        ratingsSection
                    }
                    Spacer()
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
                HStack(alignment: .firstTextBaseline, spacing: 20) {
                    Text("My Lists")
                        .font(.system(size: 28, weight: .semibold))
                        .foregroundColor(Theme.text)
                    // On a show that isn't mine, say what the chips do.
                    if myCopyChecked && myCopy == nil {
                        Text("Pick a list to add it to yours")
                            .font(.system(size: 22))
                            .foregroundColor(Theme.muted)
                    }
                }
                // Four list chips on one row, each sized to its own label so the
                // name never wraps. The colored dot carries the list identity;
                // the label and checkmark take ChipButtonStyle's foreground so
                // they invert against the focused plate. Don't re-add an
                // explicit color to either — that's what made a focused chip
                // white-on-white.
                HStack(spacing: 16) {
                    ForEach(ShowList.allCases) { l in
                        Button { Task { await chipTap(l) } } label: {
                            HStack(spacing: 10) {
                                Circle().fill(Theme.listColor(l.rawValue)).frame(width: 16, height: 16)
                                Text(l.title)
                                if cur == l {
                                    Image(systemName: "checkmark")
                                }
                            }
                            .font(.system(size: 24, weight: .semibold))
                            .lineLimit(1)
                            .fixedSize()
                        }
                        .buttonStyle(ChipButtonStyle())
                        .disabled(working)
                    }
                }
                // Archive on its own row so the list row isn't crowded and the
                // focused button has room to scale up. Not role:.destructive —
                // that painted the pill red with red text, unreadable until
                // focused. The red box icon keeps its color in both states
                // (red reads on the dark surface and on the focused plate);
                // the label follows the style's foreground.
                if let m = mineActive {
                    Button { Task { await archive(m.id) } } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "archivebox").foregroundColor(.red)
                            Text("Archive")
                        }
                        .font(.system(size: 24, weight: .semibold))
                        .lineLimit(1)
                        .fixedSize()
                    }
                    .buttonStyle(ChipButtonStyle())
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

    // Club Rating shows on every card, logged in or not; a specific
    // member's own rating shows when viewing their copy. View-only —
    // rate from iPhone/iPad. Nothing renders until the show has a
    // tmdb_id (ratings is nil until then).
    @ViewBuilder private var ratingsSection: some View {
        if let ratings {
            VStack(alignment: .leading, spacing: 10) {
                Text("Ratings")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundColor(Theme.text)
                Text(clubRatingText)
                    .font(.system(size: 24))
                    .foregroundColor(Theme.text.opacity(0.8))
                if let mine = ratings.mine {
                    Text("Your rating — \(mine)/10")
                        .font(.system(size: 24))
                        .foregroundColor(Theme.text.opacity(0.8))
                }
                if let seasons = clubSeasonRatingsText {
                    Text("Club seasons — \(seasons)")
                        .font(.system(size: 24))
                        .foregroundColor(Theme.text.opacity(0.8))
                }
                if let owner = ratings.owner {
                    Text("\(ratings.ownerName ?? "")’s rating — \(owner)/10")
                        .font(.system(size: 24))
                        .foregroundColor(Theme.text.opacity(0.8))
                }
            }
        }
    }

    // "S1 8.2 · S2 7.9" — per-season club averages, the same line the watch
    // shows. Seasons nobody has rated drop out rather than printing a blank.
    private var clubSeasonRatingsText: String? {
        guard let seasons = ratings?.seasons, !seasons.isEmpty else { return nil }
        let parts = seasons.keys.sorted().compactMap { s -> String? in
            guard let avg = seasons[s]?.average else { return nil }
            return String(format: "S%d %.1f", s, avg)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var clubRatingText: String {
        guard let avg = ratings?.average else { return "Show Picker Club Rating: No ratings yet" }
        let count = ratings?.count ?? 0
        return String(format: "Show Picker Club Rating: %.1f/10 (%d rating%@)", avg, count, count == 1 ? "" : "s")
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
                                  fullSeries: show?.isFullSeries ?? false,
                                  // The exact TMDB entry, not a title guess.
                                  tmdbId: show?.tmdbId,
                                  tmdbType: show?.tmdbId == nil ? nil : ((show?.isMovie ?? false) ? "movie" : "tv"))
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
        } catch API.APIError.badResponse(422) {
            // Every show is a TMDB entry; one TMDB has no match for isn't added.
            actionMessage = "“\(addTitle)” wasn't found in the show catalog, so it can't be added."
        } catch API.APIError.badResponse(503) {
            actionMessage = "Couldn't reach the show catalog. Please try again in a few minutes."
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
        let mine = (try? await API.myShows(slug: slug, includeArchived: true)) ?? []
        // ShowIdentity (three 2026 films are "The Odyssey"). Before the show
        // loads, only the title is known, so movie-ness is the candidate's.
        myCopy = mine.first { m in
            ShowIdentity.same(title: show?.title ?? initialTitle, isMovie: show?.isMovie ?? m.isMovie,
                              tmdbId: show?.tmdbId,
                              title: m.title, isMovie: m.isMovie, tmdbId: m.tmdbId)
        }
        myCopyChecked = true
    }

    // Cast + creator, sitting under the description on the left so it fills the
    // space beside the tall info column instead of pushing below the fold.
    @ViewBuilder private var castSection: some View {
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
            .frame(maxWidth: 720, alignment: .leading)
        }
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
            // Where it streams today, when that differs from the network the
            // watch button below names. That network is the member's record and
            // is never overwritten, so it drifts as licensing moves; this says
            // the current answer without correcting theirs. Silent when TMDB
            // names nothing or was never asked — see Show.streamingNote.
            if let note = s.streamingNote {
                Text(note).foregroundColor(Theme.text.opacity(0.7))
            }
            if let notes = s.notes, !notes.isEmpty {
                Text(notes).italic().foregroundColor(Theme.muted)
            }
            // Overview now lives under the hero image on the left, so it isn't
            // repeated here.
        }
        .font(.system(size: 24))
    }

    // "2026 · 1h 52m · TV-MA · Japanese" — the catalog facts on one line. The
    // audience score isn't repeated here; the star Label by the title already
    // shows it. Language appears only for non-English titles (see
    // Show.originalLanguageText), so the line stays short for most of the club.
    private func extraMetaLine(_ s: Show) -> String? {
        var parts: [String] = []
        if let y = s.releaseYear { parts.append(String(y)) }
        if let rt = s.runtimeText { parts.append(rt) }
        if let cr = s.contentRating, !cr.isEmpty { parts.append(cr) }
        if let lang = s.originalLanguageText { parts.append(lang) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // "Next episode: 6/29" — the same M/D formatting the iOS rows use, instead
    // of raw ISO dates.
    private func seasonLine(_ s: Show) -> String? {
        // Season count now lives in the combined series line (seriesText).
        guard let r = s.nextUpRange else { return nil }
        return "Next episode: \(r)"
    }

    // "Also watching: Alex, Dana" — first names of the other members of my
    // groups who have this on Watching. Nothing renders when there are none.
    @ViewBuilder private var groupWatchingLine: some View {
        if !groupWatchers.isEmpty {
            Label("Also watching: \(groupWatchers.map(\.name).joined(separator: ", "))",
                  systemImage: "person.2.fill")
                .font(.system(size: 24))
                .foregroundColor(Theme.text.opacity(0.7))
        }
    }

    @ViewBuilder private var watchButton: some View {
        if let s = show, s.hasRealUrl, let urlStr = s.networkUrl, let url = URL(string: urlStr) {
            // No spinner and never disabled: the button's target is known the
            // moment the URL is, now that nothing has to be looked up first.
            Button {
                openWatch(serviceUrl: url)
            } label: {
                Label(buttonLabel, systemImage: "play.fill")
                    .font(.system(size: 30, weight: .semibold))
            }
            .buttonStyle(ChipButtonStyle())
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
            }
            .buttonStyle(ChipButtonStyle())
            .padding(.top, 12)
        } else if show != nil {
            Text("No direct link yet")
                .font(.system(size: 22))
                .foregroundColor(Theme.muted)
                .padding(.top, 12)
        }
    }

    // No trailer button on tvOS. A trailer could only ever open in the YouTube
    // app — tvOS has no browser to fall back on — so on an Apple TV without
    // YouTube installed, neither youtube:// nor the https universal link is
    // accepted and the button silently did nothing. There's no way to detect
    // the app's absence beforehand, so the control can't be honest about when
    // it will work. iOS keeps its trailer button: Safari is always there.
    // (`trailer_key` still rides along on the model — the iPhone app uses it.)

    // Networks where the streaming service's tvOS app honors deep links to
    // a specific show via the plain https URL we already have. Verified on
    // device 2026-08-12: both land on the actual show.
    private static let deepLinksToShow: Set<String> = [
        "HBO Max",
        "Apple TV+",
    ]

    // Prime Video reaches the show too, but only from a watch.amazon.com URL —
    // verified on device 9/10/2026, where the club's other three Amazon shapes
    // (amazon.com/gp/video, amazon.com/.../dp, primevideo.com/detail) all
    // failed to. So this is a property of the stored URL rather than of the
    // service, and it is asked of the URL.
    private static func urlLandsOnShow(_ url: URL) -> Bool {
        url.host?.lowercased().hasSuffix("watch.amazon.com") == true
    }

    // True when we can land the user on the actual show page. Everything else
    // we can reach opens to its own home screen, and the button says "Open"
    // rather than "Watch on" to stay honest about that — so two shows on the
    // same service can legitimately read differently, because two members'
    // rows can carry different links.
    private var canDeepLink: Bool {
        if Self.deepLinksToShow.contains(network ?? "") { return true }
        guard let stored = show?.networkUrl, let url = URL(string: stored) else { return false }
        return Self.urlLandsOnShow(url)
    }

    private var buttonLabel: String {
        let n = network ?? "Streaming"
        // "Watch on X" matches the wording on web/iOS/watch — people didn't
        // realize the network name was the way to the show. When we can't
        // deep-link (just opening the service app), stay honest.
        let verb = canDeepLink ? "Watch on" : "Open"
        return "\(verb) \(n)"
    }

    // The ordered list of URLs to try for this show, best first. openWatch
    // walks it until the device accepts one.
    //
    //  1. The service's own https URL, but only for the two services whose
    //     tvOS apps actually honor it (HBO Max, Apple TV+) — those land on the
    //     real show. The HBO Max search fallback goes first too: it opens HBO
    //     Max with the title pre-filled.
    //  2. Otherwise the service's custom URL schemes, which launch the app to
    //     its home screen.
    //  3. The plain https URL last, as a backstop.
    private func openTargets(serviceUrl: URL) -> [URL] {
        let isHBOSearch = show?.isHBOMaxSearchFallback == true
        if Self.deepLinksToShow.contains(network ?? "") || isHBOSearch
            || Self.urlLandsOnShow(serviceUrl) {
            return [serviceUrl]
        }
        return StreamingApps.schemes(for: serviceUrl) + [serviceUrl]
    }

    // Walk the candidates in order, stopping at the first the device accepts.
    // openURL's completion reports acceptance, so a scheme the installed app
    // doesn't register simply falls through to the next candidate instead of
    // dead-ending the button.
    private func openWatch(serviceUrl: URL) {
        attempt(openTargets(serviceUrl: serviceUrl), at: 0)
    }

    private func attempt(_ targets: [URL], at index: Int) {
        guard index < targets.count else { openFailed = true; return }
        openURL(targets[index]) { ok in
            if ok { openFailed = false } else { attempt(targets, at: index + 1) }
        }
    }

    private func load() async {
        guard let id else {
            // Opened from a recommendation (no backing row yet) — show the
            // passed-in info and let the user pick a list to add it to.
            await refreshMyCopy()
            return
        }
        async let detail = API.showDetail(id: id)
        async let actors = API.actors(showId: id)

        if let r = try? await detail {
            show = r.show
            ratings = r.ratings
            groupWatchers = r.groupWatchers ?? []
        }
        cast = (try? await actors) ?? []
        await refreshMyCopy()
    }
}
