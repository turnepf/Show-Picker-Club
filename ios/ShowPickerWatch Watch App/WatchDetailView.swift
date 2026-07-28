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

    private var s: Show { full ?? show }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                if let p = s.posterUrl, let url = URL(string: p) {
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFit()
                        } else {
                            Color.gray.opacity(0.2)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 120)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }

                Text(s.title).font(.headline)

                // Overview (plot synopsis) right under the title, no header.
                if let ov = s.overview, !ov.isEmpty {
                    Text(ov).font(.caption2).foregroundStyle(.secondary)
                }

                if let n = s.network, !n.isEmpty {
                    // Spell the affordance out — a bare network name reads as
                    // a label, so nobody realized it led to the show.
                    if s.hasRealUrl, let u = s.networkUrl, let url = URL(string: u) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Network").font(.caption2).foregroundStyle(.secondary)
                            Link("Watch on \(n)", destination: url).font(.footnote)
                        }
                    } else if let wl = s.whereToWatchURL {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(n).font(.caption2).foregroundStyle(.secondary)
                            Link("Where to watch", destination: wl).font(.footnote)
                        }
                    } else {
                        row("Network", n)
                    }
                }
                // Single audience score, sourced from TMDB (`rating` carries it now),
                // grouped with the club's own rating.
                if let r = s.rating, !r.isEmpty { row("TMDB Rating", "★ \(r)") }
                if let ratings {
                    row("Club Rating", clubRatingText)
                    if let owner = ratings.owner {
                        row("\(ratings.ownerName ?? "")’s rating", "\(owner)/10")
                    }
                }
                if let l = ShowList(rawValue: s.list) { row("List", l.title) }
                if let up = s.nextUpRange { row("Next episode", up) }
                if let series = s.seriesText { row("Series", series) }
                if s.isMovie { row("Type", "Movie") }
                if let cr = s.contentRating, !cr.isEmpty { row("Rated", cr) }
                if let y = s.releaseYear { row("Year", String(y)) }
                if let d = s.director, !d.isEmpty {
                    // Link a single-person credit to their IMDB page (like cast).
                    if let url = s.directorURL {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(s.directorLabel).font(.caption2).foregroundStyle(.secondary)
                            Link(d, destination: url).font(.footnote)
                        }
                    } else {
                        row(s.directorLabel, d)
                    }
                }
                if let turl = s.trailerURL {
                    Link("▶ Trailer", destination: turl).font(.footnote)
                }
                if !s.genreList.isEmpty { row("Genres", s.genreList.joined(separator: ", ")) }
                if let rt = s.runtimeText { row("Runtime", rt) }
                if let by = s.recommendedBy, !by.isEmpty { row("From", by) }
                if let w = s.watchingWith, !w.isEmpty { row("With", w) }
                if !cast.isEmpty {
                    // One line per actor so each can be its own IMDB link
                    // (inline links inside a joined Text aren't tappable on
                    // watchOS). Unlinked names are legacy rows the enrich
                    // backfill hasn't reached yet.
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Cast").font(.caption2).foregroundStyle(.secondary)
                        ForEach(Array(cast.prefix(6).enumerated()), id: \.offset) { item in
                            if let imdb = item.element.imdbId, !imdb.isEmpty,
                               let url = URL(string: "https://www.imdb.com/name/\(imdb)/") {
                                Link(item.element.name, destination: url).font(.footnote)
                            } else {
                                Text(item.element.name).font(.footnote)
                            }
                        }
                    }
                }
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

    private var clubRatingText: String {
        guard let avg = ratings?.average else { return "No ratings yet" }
        let count = ratings?.count ?? 0
        return String(format: "%.1f/10 (%d rating%@)", avg, count, count == 1 ? "" : "s")
    }

    private func load() async {
        if let r = try? await WatchAPI.showDetail(id: show.id, cookie: auth.cookieHeader) {
            full = r.show
            ratings = r.ratings
        }
        cast = (try? await WatchAPI.actors(showId: show.id, cookie: auth.cookieHeader)) ?? []
    }
}
