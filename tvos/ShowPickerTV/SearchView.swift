import SwiftUI

// Cross-library search over every member's active shows (one card per title).
// Reuses the poster ShowCard; tapping a result opens the show detail.
//
// Text entry is a plain TextField, not `.searchable`. tvOS's searchable
// keyboard drew fine here — letters focusable, select pressed — and dropped
// every character on the floor. A TextField hands off to the system's
// full-screen keyboard instead, which is the ordinary way to type on an Apple
// TV and has nothing to get out of sync. Same swap in AddShowView.
struct SearchView: View {
    @EnvironmentObject private var auth: AuthStore
    @Binding var path: NavigationPath
    @State private var all: [Show] = []
    @State private var query = ""
    @State private var loaded = false
    @State private var showingAdd = false
    @FocusState private var searchFocused: Bool

    private let columns = Array(repeating: GridItem(.fixed(220), spacing: 40), count: 5)

    // De-duped, title-matched results. The /api/shows/all feed has one row per
    // member per show, so collapse by title and keep the richest copy (one with
    // a poster, else the highest rating).
    private var results: [Show] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.count >= 1 else { return [] }
        var best: [String: Show] = [:]
        for s in all {
            let cast = s.castMembers.map(\.name).joined(separator: " ")
            let hay = "\(s.title) \(s.network ?? "") \(s.genres ?? "") \(cast)".lowercased()
            guard hay.contains(q) else { continue }
            let key = s.title.lowercased()
            if let existing = best[key] {
                let better = (s.posterUrl != nil && existing.posterUrl == nil)
                    || (Double(s.rating ?? "0") ?? 0) > (Double(existing.rating ?? "0") ?? 0)
                if better { best[key] = s }
            } else {
                best[key] = s
            }
        }
        return best.values.sorted { (Double($0.rating ?? "0") ?? 0) > (Double($1.rating ?? "0") ?? 0) }
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
            // Reload after adding so the new show turns up in club search.
            .fullScreenCover(isPresented: $showingAdd, onDismiss: {
                Task { await load() }
            }) {
                AddShowView(initialQuery: query)
            }
        }
        .task { await load() }
    }

    // Click it and tvOS takes over with its full-screen keyboard; the binding
    // updates as you type there, so results are ready the moment you're back.
    private var searchField: some View {
        TextField("Shows, networks, genres", text: $query)
            .font(.system(size: 30))
            .focused($searchFocused)
            .frame(maxWidth: 900)
            .padding(.top, 40)
            .padding(.bottom, 20)
    }

    private var resultsScroll: some View {
        ScrollView {
            if query.trimmingCharacters(in: .whitespaces).isEmpty {
                hint("Click the field above to search the club's shows by title, actor, network, or genre.")
            } else if results.isEmpty {
                if loaded {
                    VStack(spacing: 28) {
                        hint("No matches for “\(query)” in the club.")
                        // Not in anyone's library yet — offer the TMDB
                        // type-ahead add (signed-in members only; the
                        // endpoints are session-gated).
                        if auth.isLoggedIn {
                            Button {
                                showingAdd = true
                            } label: {
                                Label("Add “\(query)” as a new show", systemImage: "plus")
                                    .font(.system(size: 24, weight: .semibold))
                            }
                            .buttonStyle(ActionButtonStyle())
                        }
                    }
                } else {
                    hint("Searching…")
                }
            } else {
                LazyVGrid(columns: columns, alignment: .leading, spacing: 50) {
                    ForEach(results) { show in
                        NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                            ShowCard(title: show.title,
                                     networkLogoUrl: show.networkLogoUrl,
                                     posterUrl: show.posterUrl)
                        }
                        .buttonStyle(PushButtonStyle())
                    }
                }
                .padding(.horizontal, 60)
                .padding(.vertical, 40)
            }
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 26))
            .foregroundColor(Theme.muted)
            .frame(maxWidth: .infinity)
            .padding(.top, 120)
    }

    private func load() async {
        all = (try? await API.allShows()) ?? []
        loaded = true
    }
}
