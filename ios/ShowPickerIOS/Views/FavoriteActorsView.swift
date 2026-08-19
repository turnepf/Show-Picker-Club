import SwiftUI

// Favourite actors — the people who keep turning up across your Watching,
// Awaiting and Loved lists, with a way out to their IMDB page for everything
// else they've been in.
//
// Nothing here is curated. The list is computed from the library, so it needs
// no empty-state onboarding and no "add a favourite" affordance; a member with
// a thin library gets a short list, which is honest.
struct FavoriteActorsView: View {
    @State private var actors: [FavoriteActor] = []
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        List {
            if actors.isEmpty && !loading {
                Section {
                    Text(failed
                         ? "Couldn't load your actors — pull down to try again."
                         : "No actors yet. Add a few shows to Watching, Awaiting or Loved and they'll show up here.")
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(actors) { actor in
                Section {
                    row(actor)
                }
            }

            if !actors.isEmpty {
                Section {
                    Text("Worked out from the shows on your Watching, Awaiting and Loved lists.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Favorite Actors")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        .task { if loading { await load() } }
        .overlay { if loading && actors.isEmpty { ProgressView() } }
    }

    @ViewBuilder
    private func row(_ actor: FavoriteActor) -> some View {
        // The name is the link when IMDB gave us an id, and plain text when it
        // didn't — rather than a link that goes nowhere.
        if let url = actor.imdbURL {
            Link(destination: url) {
                LabeledContent {
                    Image(systemName: "arrow.up.right.square")
                        .foregroundStyle(.secondary)
                } label: {
                    header(actor)
                }
            }
        } else {
            header(actor)
        }

        // Why they're on the list — the member's own copies, drawn as the
        // standard show row and opening the same card every other screen
        // opens. The count and the rows say the same thing, but the rows are
        // the part that makes it feel true.
        if let cards = actor.showCards, !cards.isEmpty {
            ForEach(cards) { card in
                NavigationLink {
                    ShowDetailView(id: card.id, initialTitle: card.title,
                                   initialNetwork: card.network, initialRating: card.rating,
                                   initialPoster: card.posterUrl)
                } label: {
                    ShowRow(card)
                }
            }
        } else {
            // A payload without cards (older cached response) still names the
            // titles rather than rendering an empty section.
            ForEach(actor.shows, id: \.self) { title in
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func header(_ actor: FavoriteActor) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(actor.name)
                .font(.headline)
            Text(actor.showCount == 1 ? "1 show" : "\(actor.showCount) shows")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        let result = try? await API.favoriteActors()
        failed = (result == nil)
        // Stale beats blank, same as Home's Trending shelf.
        actors = result ?? actors
    }
}
