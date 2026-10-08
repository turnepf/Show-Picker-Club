import SwiftUI
import ShowPickerCore

// Screen 3: the show detail — the same facts the iOS detail shows, laid out
// for the wrist. Loads the full row + cast by id (public reads).
struct WatchDetailView: View {
    let show: Show
    @EnvironmentObject private var auth: WatchAuth
    @State private var full: Show?
    @State private var cast: [Actor] = []
    // Average/count always present once the show has a tmdb_id; `owner`
    // populates only when viewing a specific other member's copy. The
    // watch is view-only for ratings — rate from iPhone/iPad.
    @State private var ratings: RatingsSummary?
    // Others in my groups watching this same title. Comes back on the same
    // detail call; empty for a logged-out watch or a member in no groups.
    @State private var groupWatchers: [GroupWatcher] = []

    private var s: Show { full ?? show }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                // Backdrop first, poster only as the fallback — same order as
                // the phone. A 16:9 still fills the watch's width; a portrait
                // poster wasted most of it on letterboxing.
                if let hero = heroURL {
                    AsyncImage(url: hero.url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFit()
                        } else {
                            Color.gray.opacity(0.2)
                        }
                    }
                    .aspectRatio(hero.isBackdrop ? 16.0 / 9.0 : 2.0 / 3.0, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }

                Text(s.title).font(.headline)

                // Overview (plot synopsis) right under the title, no header.
                if let ov = s.overview, !ov.isEmpty {
                    Text(ov).font(.caption2).foregroundStyle(.secondary)
                }

                // Cast right under the overview. Plain names, not links —
                // watchOS has no browser, so the IMDB links these used to
                // carry went nowhere.
                if !cast.isEmpty {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Cast").font(.caption2).foregroundStyle(.secondary)
                        ForEach(Array(cast.prefix(6).enumerated()), id: \.offset) { item in
                            Text(item.element.name).font(.footnote)
                        }
                    }
                }
                // Creator/Director just below the cast, plain text (the IMDB
                // link this used to carry is dead on the watch).
                if let d = s.director, !d.isEmpty {
                    row(s.directorLabel, d)
                }

                // Who else in my groups is watching this, above the network
                // line — the social context reads before the where-to-watch.
                if !groupWatchers.isEmpty {
                    row("Also watching", groupWatchers.map(\.name).joined(separator: ", "))
                }

                // Where to watch — informational only. The watch can't open a
                // streaming service, so this is a plain labeled row, not a link.
                if let n = s.network, !n.isEmpty {
                    row("Network", n)
                }

                // Ratings grouped together, the club's own score first, then
                // mine, then whoever's copy this is. Rating happens on the
                // phone; the watch just reports the numbers.
                if let ratings {
                    row("Show Picker Club Rating", clubRatingText)
                    if let mine = ratings.mine {
                        row("Your rating", "\(mine)/10")
                    }
                    if let clubSeasons = clubSeasonRatingsText {
                        row("Club seasons", clubSeasons)
                    }
                    if let seasons = mySeasonRatingsText {
                        row("Your seasons", seasons)
                    }
                    if let owner = ratings.owner {
                        row("\(ratings.ownerName ?? "")’s rating", "\(owner)/10")
                    }
                }
                // Single audience score, sourced from TMDB (`rating` carries it now).
                if let r = s.rating, !r.isEmpty { row("TMDB Rating", "★ \(r)") }

                if let l = ShowList(rawValue: s.list) { row("List", l.title) }
                // Premiere when there is one, else the finale date ("through
                // 6/12") — the phone's fallback, which the watch was missing.
                if let season = s.currentSeasonRow { row(season.label, season.value) }
                if let dates = s.seasonDatesText { row("Next episode", dates) }
                if let series = s.seriesText { row("Series", series) }
                if s.isMovie { row("Type", "Movie") }
                if let cr = s.contentRating, !cr.isEmpty { row("Rated", cr) }
                if let y = s.releaseYear { row("Year", String(y)) }
                if !s.genreList.isEmpty { row("Genres", s.genreList.joined(separator: ", ")) }
                if let rt = s.runtimeText { row("Runtime", rt) }
                if let by = s.recommendedBy, !by.isEmpty { row("From", by) }
                if let w = s.watchingWith, !w.isEmpty { row("With", w) }
                if let notes = s.notes, !notes.isEmpty {
                    Text(notes).font(.caption2).foregroundStyle(.secondary).italic()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(s.title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func row(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.footnote)
        }
    }

    // Backdrop (16:9) when the row has one, poster (2:3) otherwise, so the
    // frame can match whichever it drew.
    private var heroURL: (url: URL, isBackdrop: Bool)? {
        if let b = s.backdropUrl, !b.isEmpty, let url = URL(string: b) { return (url, true) }
        if let p = s.posterUrl, !p.isEmpty, let url = URL(string: p) { return (url, false) }
        return nil
    }

    // "S1 8.2 · S2 7.9" — what the club averaged per season, which the web
    // shows and the wrist was missing. Only seasons anyone has rated.
    private var clubSeasonRatingsText: String? {
        guard let seasons = ratings?.seasons, !seasons.isEmpty else { return nil }
        // average is nil for a season nobody has rated yet — those drop out
        // rather than printing an empty score.
        let parts = seasons.keys.sorted().compactMap { s -> String? in
            guard let avg = seasons[s]?.average else { return nil }
            return String(format: "S%d %.1f", s, avg)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // "S1 8 · S2 9" — only the seasons I've actually rated.
    private var mySeasonRatingsText: String? {
        guard let mine = ratings?.mineSeasons, !mine.isEmpty else { return nil }
        return mine.keys.sorted().map { "S\($0) \(mine[$0]!)" }.joined(separator: " · ")
    }

    private var clubRatingText: String {
        guard let avg = ratings?.average else { return "No ratings yet" }
        let count = ratings?.count ?? 0
        return String(format: "%.1f/10 (%d rating%@)", avg, count, count == 1 ? "" : "s")
    }

    private func load() async {
        if let r = try? await WatchAPI.showDetail(id: show.id, cookie: auth.cookieHeader) {
            full = r.show
            ratings = r.ratings
            groupWatchers = r.groupWatchers ?? []
        }
        cast = (try? await WatchAPI.actors(showId: show.id, cookie: auth.cookieHeader)) ?? []
    }
}
