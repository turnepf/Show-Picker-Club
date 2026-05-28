import SwiftUI

struct ShowDetailView: View {
    let id: Int
    let initialTitle: String
    let initialNetwork: String?
    let initialRating: String?

    @EnvironmentObject private var auth: AuthStore
    @State private var show: Show?
    @State private var cast: [Actor] = []
    @State private var showingEdit = false
    @Environment(\.openURL) private var openURL

    private var title: String { show?.title ?? initialTitle }
    private var network: String? { show?.network ?? initialNetwork }
    private var rating: String? { show?.rating ?? initialRating }
    private var isMine: Bool {
        guard let mine = auth.memberSlug, let s = show else { return false }
        return s.memberSlug == mine
    }

    var body: some View {
        Form {
            Section {
                LabeledContent("Title", value: title)
                if let n = network, !n.isEmpty { LabeledContent("Network", value: n) }
                if let r = rating, !r.isEmpty {
                    LabeledContent("Rating") {
                        Label(r, systemImage: "star.fill").foregroundStyle(.orange)
                    }
                }
                if let s = show {
                    LabeledContent("List", value: ShowList(rawValue: s.list)?.title ?? s.list.capitalized)
                    if s.isMovie { LabeledContent("Type", value: "Movie") }
                    if s.isFullSeries { LabeledContent("Series", value: "🎬 Complete") }
                }
            }

            if let s = show, !s.genreList.isEmpty {
                Section("Genres") {
                    Text(s.genreList.joined(separator: " · "))
                        .foregroundStyle(.secondary)
                }
            }

            if let s = show {
                if let by = s.recommendedBy, !by.isEmpty {
                    Section { LabeledContent("Recommended by", value: by) }
                }
                if let w = s.watchingWith, !w.isEmpty {
                    Section { LabeledContent("Watching with", value: w) }
                }
                if let dates = seasonDates(s) {
                    Section { LabeledContent("Next up", value: dates) }
                }
                if let notes = s.notes, !notes.isEmpty {
                    Section("Notes") {
                        Text(notes).foregroundStyle(.secondary)
                    }
                }
            }

            if !cast.isEmpty {
                Section("Cast") {
                    Text(cast.prefix(10).map { $0.name }.joined(separator: ", "))
                        .foregroundStyle(.secondary)
                }
            }

            if let urlStr = show?.networkUrl,
               let url = URL(string: urlStr),
               isRealUrl(urlStr) {
                Section {
                    Button {
                        openURL(url)
                    } label: {
                        Label("Watch on \(network ?? "Streaming")", systemImage: "play.fill")
                    }
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if isMine {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { showingEdit = true }
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showingEdit) {
            if let s = show {
                AddEditShowView(memberSlug: s.memberSlug ?? "", existing: s) { await load() }
            }
        }
    }

    private func seasonDates(_ s: Show) -> String? {
        let start = s.nextSeasonDate, end = s.seasonEndDate
        if let start, !start.isEmpty, let end, !end.isEmpty { return "\(start) – \(end)" }
        if let start, !start.isEmpty { return start }
        if let end, !end.isEmpty { return "through \(end)" }
        return nil
    }

    private func isRealUrl(_ u: String) -> Bool {
        let l = u.lowercased()
        if l.isEmpty || l == "#" { return false }
        return !(l.contains("/search") || l.contains("/s?") || l.contains("?q=") || l.contains("?query="))
    }

    private func load() async {
        if let s = try? await API.showDetail(id: id) { show = s }
        cast = (try? await API.actors(showId: id)) ?? []
    }
}
