import SwiftUI

// Find a show — the one way to add a show, and the one search.
//
// It used to be two things that looked like one: a magnifying glass that only
// searched shows your group-mates already had, and a separate "+" that could
// add anything. A new member reached for the magnifying glass, found nothing
// because nobody they knew had the show yet, and concluded it couldn't be
// added. Now what you type goes to TMDB, and every result can be added.
//
// What's already in the club rides along as context rather than being the
// result set: your own copies (archived too — tapping one opens its card,
// which is where Restore lives) come first, and each TMDB hit names the
// group-mates who have that title.
struct SearchView: View {
    // The list a new show starts on. My Shows passes the list on screen, so
    // searching from Awaiting adds to Awaiting; Home leaves it at Watching.
    var initialList: ShowList = .watching

    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @FocusState private var fieldFocused: Bool

    // My whole library, archived rows included, and my groups' active shows.
    // Both are context for the TMDB hits, so a failure on either just leaves
    // that context out rather than blocking the search.
    @State private var mine: [Show] = []
    @State private var groupShows: [AllShow] = []

    @State private var hits: [TitleHit] = []
    @State private var searching = false
    @State private var searchFailed = false

    @State private var adding: AddTarget?

    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }

    // My copies whose title or cast matches — the in-library actor search
    // the old per-member search had, kept for your own shows.
    private var myMatches: [Show] {
        let q = trimmed.lowercased()
        guard q.count >= 2 else { return [] }
        return mine.filter { s in
            s.title.lowercased().contains(q) || s.castMembers.contains { $0.name.lowercased().contains(q) }
        }
    }

    // TMDB hits not already listed above: a show you have is one row (your
    // copy), not two. Movie-ness is part of the match so owning Fargo the
    // series doesn't hide Fargo the film.
    private var newHits: [TitleHit] {
        hits.filter { hit in
            !myMatches.contains { sameShow($0.title, $0.isMovie, $0.tmdbId, hit) }
        }
    }

    // The same TMDB entry when both sides know theirs: three 2026 films are
    // called "The Odyssey", and a group-mate's copy of one must not label the
    // other two. The title (and movie-ness) only decides when a copy has no
    // id, or the server is too old to send it.
    private func sameShow(_ title: String, _ isMovie: Bool, _ tmdbId: Int?, _ hit: TitleHit) -> Bool {
        guard isMovie == hit.isMovie else { return false }
        if let tmdbId { return tmdbId == hit.tmdbId }
        return title.lowercased() == hit.title.lowercased()
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("Show or movie title", text: $query)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.words)
                            .submitLabel(.search)
                            .focused($fieldFocused)
                    }
                }
                if !auth.isLoggedIn {
                    Section {
                        Text("Sign in to find shows and add them to your lists.")
                            .foregroundStyle(.secondary)
                    }
                } else if trimmed.count < 2 {
                    Section {
                        Text("Type a title to find any show or movie and add it to your lists.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    if !myMatches.isEmpty {
                        Section("On your lists") {
                            ForEach(myMatches) { myRow($0) }
                        }
                    }
                    Section {
                        if searching && hits.isEmpty {
                            HStack { Spacer(); ProgressView(); Spacer() }
                        } else if searchFailed {
                            Text("Couldn't reach the show catalog.")
                                .foregroundStyle(.secondary)
                        } else if newHits.isEmpty && myMatches.isEmpty {
                            Text("No shows found for “\(trimmed)”.")
                                .foregroundStyle(.secondary)
                        }
                        ForEach(newHits) { hitRow($0) }
                        // TMDB doesn't know everything (a regional channel, a
                        // brand-new special), and it can be unreachable.
                        // Typing it in is always the way out.
                        Button {
                            adding = AddTarget(hit: nil, title: trimmed)
                        } label: {
                            Label("Add “\(trimmed)” by hand", systemImage: "square.and.pencil")
                        }
                    } header: {
                        Text("Add a show")
                    } footer: {
                        if !newHits.isEmpty {
                            Text("Tap a show to add it — poster, rating and cast come with it.")
                        }
                    }
                }
            }
            .navigationTitle("Find a Show")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await loadLibraries() }
            .task(id: trimmed) { await searchTitles() }
            .onAppear { fieldFocused = true }
            .sheet(item: $adding) { target in
                if let slug = auth.memberSlug {
                    AddEditShowView(memberSlug: slug, existing: nil, initialList: initialList,
                                    initialTitle: target.title, initialPick: target.hit) {
                        // Stay open: the show moves up into "On your lists",
                        // which is the confirmation, and the next one can be
                        // searched without reopening anything.
                        await loadLibraries()
                    }
                }
            }
        }
    }

    // One of my own copies. Opens its card — edit, move, or (archived) Restore.
    @ViewBuilder private func myRow(_ s: Show) -> some View {
        NavigationLink {
            ShowDetailView(id: s.id, initialTitle: s.title,
                           initialNetwork: s.network, initialRating: s.rating,
                           initialPoster: s.posterUrl, initialNetworkUrl: s.networkUrl)
        } label: {
            ShowRow(
                s,
                caption: [s.network, s.isArchived ? "Archived" : (ShowList(rawValue: s.list)?.title ?? s.list)]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                captionTint: s.isArchived ? .orange : nil,
                alignment: .top
            )
        }
    }

    // A TMDB hit. Tapping opens Add Show with this exact entry pinned.
    @ViewBuilder private func hitRow(_ hit: TitleHit) -> some View {
        Button {
            adding = AddTarget(hit: hit, title: hit.title)
        } label: {
            HStack(spacing: 12) {
                PosterThumb(url: hit.posterUrl, width: 40, height: 60)
                VStack(alignment: .leading, spacing: 2) {
                    Text(hit.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(hit.metaText)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let who = groupLine(for: hit) {
                        Label(who, systemImage: "person.2.fill")
                            .font(.caption)
                            .foregroundStyle(.tint)
                    }
                }
                Spacer()
                Image(systemName: "plus.circle.fill")
                    .font(.title3)
                    .foregroundStyle(.tint)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Adds this show to your lists")
    }

    // "Quinn · Watching, Amy · Loved" — group-mates with this show, and
    // where they keep it. Matched on the TMDB entry, falling back to title and
    // movie-ness for a copy with no id; three names, then a count.
    private func groupLine(for hit: TitleHit) -> String? {
        var seen = Set<String>()
        let people = groupShows
            .filter { $0.memberSlug != auth.memberSlug && sameShow($0.title, $0.isMovie, $0.tmdbId, hit) }
            .filter { seen.insert($0.memberSlug).inserted }
            .map { "\($0.ownerLabel) · \($0.listLabel)" }
        guard !people.isEmpty else { return nil }
        let shown = people.prefix(3).joined(separator: ", ")
        return people.count > 3 ? "\(shown) +\(people.count - 3)" : shown
    }

    private func loadLibraries() async {
        guard let slug = auth.memberSlug else { return }
        async let myShows = try? API.shows(member: slug, includeArchived: true)
        async let groups = try? API.allShows()
        if let m = await myShows { mine = m }
        if let g = await groups { groupShows = g }
    }

    // Debounced TMDB lookup. .task(id:) cancels the in-flight one on every
    // keystroke, so only the pause after typing reaches the network.
    private func searchTitles() async {
        let q = trimmed
        guard auth.isLoggedIn, q.count >= 2 else {
            hits = []; searching = false; searchFailed = false
            return
        }
        searching = true
        try? await Task.sleep(nanoseconds: 300_000_000)
        if Task.isCancelled { return }
        do {
            let result = try await API.titleSearch(q)
            if Task.isCancelled { return }
            hits = result
            searchFailed = false
        } catch {
            if Task.isCancelled { return }
            hits = []
            searchFailed = true
        }
        searching = false
    }
}

// What the Add sheet opens with: a pinned TMDB pick, or just typed text.
private struct AddTarget: Identifiable {
    let id = UUID()
    let hit: TitleHit?
    let title: String
}
