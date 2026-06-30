import SwiftUI

// Cross-library search over every member's active shows (one card per title).
// Reuses the poster ShowCard; tapping a result opens the show detail.
struct SearchView: View {
    @State private var all: [Show] = []
    @State private var query = ""
    @State private var loaded = false

    private let columns = Array(repeating: GridItem(.fixed(220), spacing: 40), count: 5)

    // De-duped, title-matched results. The /api/shows/all feed has one row per
    // member per show, so collapse by title and keep the richest copy (one with
    // a poster, else the highest rating).
    private var results: [Show] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard q.count >= 1 else { return [] }
        var best: [String: Show] = [:]
        for s in all {
            let hay = "\(s.title) \(s.network ?? "") \(s.genres ?? "")".lowercased()
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
        NavigationStack {
            ScrollView {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    hint("Search the club's shows by title, network, or genre.")
                } else if results.isEmpty {
                    hint(loaded ? "No matches for “\(query)”." : "Searching…")
                } else {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 50) {
                        ForEach(results) { show in
                            NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                                ShowCard(title: show.title,
                                         network: show.network,
                                         fullSeries: show.isFullSeries,
                                         posterUrl: show.posterUrl)
                            }
                            .buttonStyle(PushButtonStyle())
                        }
                    }
                    .padding(.horizontal, 60)
                    .padding(.vertical, 40)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Search")
            .searchable(text: $query, prompt: "Shows, networks, genres")
            .showDestinations()
        }
        .task { await load() }
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
