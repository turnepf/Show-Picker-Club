import SwiftUI

// Favourite actors — the people who keep turning up in the shows you rated
// highly, loved, or are watching, with a way out to their IMDB page for
// everything else they've been in.
//
// Nothing here is curated. The list is computed from the library and your
// ratings, so it needs no "add a favourite" affordance; the one nudge is Rate
// My Shows, offered while too few titles are rated for ratings to lead.
struct FavoriteActorsView: View {
    // Retires the UPDATED flag on Home and the iPad sidebar. A new key for a
    // future change to the ranking brings the flag back.
    static let seenUpdateKey = "seenFavoriteActorsUpdate"
    @AppStorage(FavoriteActorsView.seenUpdateKey) private var seenUpdate = false
    // Captured on the visit that retires the flag, so the banner explains the
    // UPDATED the member just tapped rather than vanishing as it's read.
    @State private var showUpdateBanner = false

    @State private var actors: [FavoriteActor] = []
    @State private var ratedCount: Int?
    @State private var ratingGoal = 8
    @State private var needsRatings = false
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        List {
            if showUpdateBanner {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("New algorithm!", systemImage: "sparkles")
                            .font(.headline)
                            .foregroundStyle(Color.accentColor)
                        Text("Shows you rate 8 or higher now count most — even ones you've archived.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            // Alongside the actors, never instead of them: the list works
            // unrated, ratings are what sharpen it.
            if needsRatings && !loading {
                Section {
                    NavigationLink {
                        RateBacklogView()
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Label("Rate your shows", systemImage: "star.fill")
                                .font(.headline)
                            Text(ratePrompt)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

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
                    Text("Worked out from your ratings — shows you rated 8 or higher count most, archived ones included — and the shows on your Watching, Awaiting and Loved lists.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Favorite Actors")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await load() }
        // Every appearance, not just the first: coming back from Rate My Shows
        // should show the ratings you just gave.
        .task { await load() }
        .onAppear {
            if !seenUpdate {
                showUpdateBanner = true
                seenUpdate = true
            }
        }
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
                    ShowRow(card, caption: caption(card),
                            captionTint: card.isArchived ? .orange : nil)
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

    // Why this copy counts: the member's own rating, and Archived when it's
    // off their lists. Nil keeps the standard network line.
    private func caption(_ card: FavoriteActorShow) -> String? {
        var parts: [String] = []
        if card.isArchived {
            parts.append("Archived")
        } else if let network = card.network, !network.isEmpty {
            parts.append(network)
        }
        if let mine = card.myRating { parts.append("You rated \(mine)") }
        return card.isArchived || card.myRating != nil ? parts.joined(separator: " · ") : nil
    }

    private var ratePrompt: String {
        let n = ratedCount ?? 0
        return n == 0
            ? "Shows you rate 8 or higher count most here. Rate \(ratingGoal) to get started."
            : "You've rated \(n) of \(ratingGoal). Shows you rate 8 or higher count most here."
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
        guard let result else { return }
        actors = result.actors
        ratedCount = result.ratedCount
        ratingGoal = result.ratingGoal ?? ratingGoal
        needsRatings = result.needsRatings ?? false
    }
}
