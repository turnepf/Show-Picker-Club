import SwiftUI
import ShowPickerCore

// Screen 3: the show detail — the same facts the iOS detail shows, laid out
// for the wrist. Loads the full row + cast by id (public reads).
struct WatchDetailView: View {
    let show: Show
    @EnvironmentObject private var auth: WatchAuth
    @State private var full: Show?
    @State private var cast: [Actor] = []
    @State private var posterExpanded = false

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
                    // Tap to view full screen; tap again to come back.
                    .onTapGesture { posterExpanded = true }
                }

                Text(s.title).font(.headline)

                if let n = s.network, !n.isEmpty {
                    // Spell the affordance out — a bare network name reads as
                    // a label, so nobody realized it led to the show.
                    if s.hasRealUrl, let u = s.networkUrl, let url = URL(string: u) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Network").font(.caption2).foregroundStyle(.secondary)
                            Link("Go to show on \(n)", destination: url).font(.footnote)
                        }
                    } else {
                        row("Network", n)
                    }
                }
                if let r = s.rating, !r.isEmpty { row("Rating", "★ \(r)") }
                if let l = ShowList(rawValue: s.list) { row("List", l.title) }
                if let up = s.nextUpRange { row("Next episode", up) }
                if let seasons = s.seasonsText { row("Seasons", seasons) }
                if s.isMovie { row("Type", "Movie") }
                if !s.genreList.isEmpty { row("Genres", s.genreList.joined(separator: ", ")) }
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
        .sheet(isPresented: $posterExpanded) {
            if let p = s.posterUrl, let url = URL(string: p) {
                ZStack {
                    Color.black.ignoresSafeArea()
                    AsyncImage(url: url) { phase in
                        if let image = phase.image {
                            image.resizable().scaledToFit()
                        } else {
                            ProgressView()
                        }
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { posterExpanded = false }
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label).font(.caption2).foregroundStyle(.secondary)
            Text(value).font(.footnote)
        }
    }

    private func load() async {
        if let s = try? await WatchAPI.showDetail(id: show.id, cookie: auth.cookieHeader) { full = s }
        cast = (try? await WatchAPI.actors(showId: show.id, cookie: auth.cookieHeader)) ?? []
    }
}
