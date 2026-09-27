import SwiftUI

// Find a Show — the Search tab, and the one way to add a show on the TV.
//
// Same change as iPhone and iPad: search used to look only at the shows your
// group-mates already had, with adding off behind a separate "Add a Show"
// button on My Shows, so a title nobody you knew had just wasn't there. Now
// what you type goes to TMDB and every result can be added. The club rides
// along as context: your own copies come first (archived too — their card is
// where Restore lives), and a focused result names the group-mates who have
// it.
//
// Text entry is a plain TextField, not `.searchable`. tvOS's searchable
// keyboard drew fine here — letters focusable, select pressed — and dropped
// every character on the floor. A TextField hands off to the system's
// full-screen keyboard instead, which is the ordinary way to type on an Apple
// TV and has nothing to get out of sync.
struct SearchView: View {
    @EnvironmentObject private var auth: AuthStore
    @Binding var path: NavigationPath
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    // Context for the TMDB hits; a failed load just leaves it out.
    @State private var mine: [Show] = []
    @State private var groupCopies: [GroupCopy] = []

    @State private var hits: [TitleHit] = []
    @State private var searching = false
    @State private var searchFailed = false

    // The list-choice step for a result (or a typed title).
    @State private var adding: AddTarget?
    @State private var working = false
    @State private var errorText: String?

    private let columns = Array(repeating: GridItem(.fixed(220), spacing: 40), count: 5)

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    // My copies whose title or cast matches, archived included.
    private var myMatches: [Show] {
        let q = trimmed.lowercased()
        guard q.count >= 2 else { return [] }
        return mine.filter { s in
            s.title.lowercased().contains(q) || s.castMembers.contains { $0.name.lowercased().contains(q) }
        }
    }

    // A title you already have is shown once, as your copy. Movie-ness is part
    // of the match so owning Fargo the series doesn't hide Fargo the film.
    private var newHits: [TitleHit] {
        hits.filter { hit in
            !myMatches.contains { sameTitle($0.title, $0.isMovie, hit) }
        }
    }

    private func sameTitle(_ title: String, _ isMovie: Bool, _ hit: TitleHit) -> Bool {
        isMovie == hit.isMovie && title.lowercased() == hit.title.lowercased()
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                searchField
                resultsScroll
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Search")
            .showDestinations()
            .navigationDestination(item: $adding) { target in
                confirmStep(target)
            }
        }
        // Keyed on the session so signing in from the Account tab fills it.
        .task(id: auth.memberSlug) { await loadLibraries() }
        // Debounced TMDB lookup: .task(id:) cancels the in-flight search on
        // every keystroke, so only the pause-after-typing one hits the network.
        .task(id: trimmed) { await search() }
    }

    // Click it and tvOS takes over with its full-screen keyboard; the binding
    // updates as you type there, so results are ready the moment you're back.
    private var searchField: some View {
        TextField("Show or movie title", text: $query)
            .font(.system(size: 30))
            .focused($searchFocused)
            .frame(maxWidth: 900)
            .padding(.top, 40)
            .padding(.bottom, 20)
    }

    private var resultsScroll: some View {
        ScrollView {
            if !auth.isLoggedIn {
                hint("Sign in from the Sign In tab to find shows and add them to your lists.")
            } else if trimmed.count < 2 {
                hint("Click the field above and type a show or movie title to add it to your lists.")
            } else {
                VStack(alignment: .leading, spacing: 30) {
                    if !myMatches.isEmpty {
                        sectionHeader("On your lists")
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 50) {
                            ForEach(myMatches) { mineCard($0) }
                        }
                    }
                    sectionHeader("Add a show")
                    if searching && hits.isEmpty {
                        note("Searching…")
                    } else if searchFailed {
                        note("Couldn't reach the show catalog.")
                    } else if newHits.isEmpty && myMatches.isEmpty {
                        note("No shows found for “\(trimmed)”.")
                    }
                    if !newHits.isEmpty {
                        LazyVGrid(columns: columns, alignment: .leading, spacing: 50) {
                            ForEach(newHits) { hitCard($0) }
                        }
                    }
                    // TMDB doesn't know everything, and it can be unreachable.
                    Button {
                        errorText = nil
                        adding = AddTarget(hit: nil, title: trimmed)
                    } label: {
                        Label("Add “\(trimmed)” as typed", systemImage: "square.and.pencil")
                            .font(.system(size: 24, weight: .semibold))
                    }
                    .buttonStyle(ActionButtonStyle())
                }
                .padding(.horizontal, 60)
                .padding(.vertical, 40)
            }
        }
    }

    private func mineCard(_ s: Show) -> some View {
        NavigationLink(value: Route.detail(id: s.id, title: s.title, network: s.network, rating: s.rating)) {
            ShowCard(title: s.title,
                     subtitle: s.isArchived ? "Archived" : ShowList(rawValue: s.list)?.title,
                     networkLogoUrl: s.networkLogoUrl,
                     posterUrl: s.posterUrl)
        }
        .buttonStyle(PushButtonStyle())
    }

    private func hitCard(_ hit: TitleHit) -> some View {
        Button {
            errorText = nil
            adding = AddTarget(hit: hit, title: hit.title)
        } label: {
            ShowCard(title: hit.title,
                     subtitle: [hit.metaText, groupLine(for: hit)].compactMap { $0 }.joined(separator: "\n"),
                     posterUrl: hit.posterUrl)
        }
        .buttonStyle(PushButtonStyle())
    }

    // "Quinn · Watching, Amy · Loved" — group-mates with this title and where
    // they keep it; two names, then a count, to fit under a poster.
    private func groupLine(for hit: TitleHit) -> String? {
        var seen = Set<String>()
        let people = groupCopies
            .filter { $0.memberSlug != auth.memberSlug && sameTitle($0.title, $0.isMovie, hit) }
            .filter { seen.insert($0.memberSlug).inserted }
            .map { "\($0.memberName ?? $0.memberSlug) · \($0.listLabel)" }
        guard !people.isEmpty else { return nil }
        let shown = people.prefix(2).joined(separator: ", ")
        return people.count > 2 ? "\(shown) +\(people.count - 2)" : shown
    }

    // Which list gets the show. A list button adds and pops back to the
    // results, where the show now sits under "On your lists".
    private func confirmStep(_ target: AddTarget) -> some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 28) {
                ShowCard(title: target.title,
                         subtitle: target.hit?.metaText,
                         posterUrl: target.hit?.posterUrl)
                    .frame(width: 220, height: 330)

                Text("Add “\(target.title)” to…")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundColor(Theme.text)

                HStack(spacing: 24) {
                    ForEach(ShowList.allCases) { l in
                        Button(l.title) { Task { await add(target, to: l) } }
                            .disabled(working)
                    }
                }
                .buttonStyle(ActionButtonStyle())

                if let errorText {
                    Text(errorText)
                        .font(.system(size: 22))
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 900)
                }
            }
            .padding(.horizontal, 60)
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 32, weight: .semibold))
            .foregroundColor(Theme.text)
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 24))
            .foregroundColor(Theme.muted)
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 26))
            .foregroundColor(Theme.muted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.top, 120)
    }

    // MARK: Data

    private func loadLibraries() async {
        guard let slug = auth.memberSlug else { mine = []; groupCopies = []; return }
        async let myShows = try? API.myShows(slug: slug, includeArchived: true)
        async let groups = try? API.groupCopies()
        if let m = await myShows { mine = m }
        if let g = await groups { groupCopies = g }
    }

    private func search() async {
        let q = trimmed
        guard auth.isLoggedIn, q.count >= 2 else {
            hits = []; searching = false; searchFailed = false
            return
        }
        searching = true
        try? await Task.sleep(nanoseconds: 300_000_000)
        if Task.isCancelled { return }
        do {
            let found = try await API.titleSearch(q)
            if Task.isCancelled { return }
            hits = found
            searchFailed = false
        } catch {
            if Task.isCancelled { return }
            hits = []
            searchFailed = true
        }
        searching = false
    }

    private func add(_ target: AddTarget, to list: ShowList) async {
        working = true
        errorText = nil
        defer { working = false }
        do {
            try await API.addShow(title: target.title, network: nil, networkUrl: nil,
                                  list: list.rawValue, movie: target.hit?.isMovie ?? false,
                                  fullSeries: false,
                                  tmdbId: target.hit?.tmdbId, tmdbType: target.hit?.mediaType)
            await loadLibraries()
            adding = nil
        } catch API.APIError.badResponse(409) {
            errorText = "“\(target.title)” is already on one of your lists (maybe archived)."
        } catch API.APIError.badResponse(401) {
            errorText = "You're logged out — sign in again from the Account tab."
        } catch {
            errorText = "Couldn't add it. Please try again."
        }
    }
}

// What the list-choice step adds: a pinned TMDB pick, or just typed text.
private struct AddTarget: Identifiable, Hashable {
    let id = UUID()
    let hit: TitleHit?
    let title: String
}
