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

                // Where to watch — informational only. The watch can't open a
                // streaming service, so this is a plain label, not a link.
                if let n = s.network, !n.isEmpty {
                    Text("Watch on \(n)").font(.footnote)
                }

                // Ratings grouped together, the club's own score first.
                if let ratings {
                    row("Club Rating", clubRatingText)
                    if let owner = ratings.owner {
                        row("\(ratings.ownerName ?? "")’s rating", "\(owner)/10")
                    }
                }
                // Single audience score, sourced from TMDB (`rating` carries it now).
                if let r = s.rating, !r.isEmpty { row("TMDB Rating", "★ \(r)") }

                if let l = ShowList(rawValue: s.list) { row("List", l.title) }
                if let up = s.nextUpRange { row("Next episode", up) }
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
