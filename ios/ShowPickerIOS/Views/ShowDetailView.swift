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
    @State private var addingToMine = false
    @State private var addAlert: AddAlert?
    @Environment(\.openURL) private var openURL

    private var title: String { show?.title ?? initialTitle }
    private var network: String? { show?.network ?? initialNetwork }
    private var rating: String? { show?.rating ?? initialRating }
    private var isMine: Bool {
        guard let mine = auth.memberSlug, let s = show else { return false }
        return s.memberSlug == mine
    }
    // Logged in, viewing someone else's (or a popular) show → can copy it onto a list of mine.
    private var canAddToMine: Bool {
        auth.memberSlug != nil && show != nil && !isMine
    }

    var body: some View {
        Form {
            // Everything factual in one compact card so a show fits on one screen.
            Section {
                LabeledContent("Title", value: title)
                if let n = network, !n.isEmpty { LabeledContent("Network", value: n) }
                if let r = rating, !r.isEmpty {
                    LabeledContent("Rating") {
                        Text("\(Image(systemName: "star.fill")) \(r)").foregroundStyle(.orange)
                    }
                }
                if let s = show {
                    LabeledContent("List", value: ShowList(rawValue: s.list)?.title ?? s.list.capitalized)
                    if s.isMovie { LabeledContent("Type", value: "Movie") }
                    if s.isFullSeries { LabeledContent("Series", value: "Complete") }
                    if !s.genreList.isEmpty {
                        LabeledContent("Genres", value: s.genreList.joined(separator: " · "))
                    }
                    if let by = s.recommendedBy, !by.isEmpty {
                        LabeledContent("Recommended by", value: by)
                    }
                    if let w = s.watchingWith, !w.isEmpty {
                        LabeledContent("Watching with", value: w)
                    }
                    if let dates = s.seasonDatesText {
                        LabeledContent("Next up", value: dates)
                    }
                }
            }

            if let s = show, let notes = s.notes, !notes.isEmpty {
                Section("Notes") {
                    Text(notes).font(.callout).foregroundStyle(.secondary)
                }
            }

            if !cast.isEmpty {
                Section("Cast") {
                    Text(cast.prefix(8).map { $0.name }.joined(separator: ", "))
                        .font(.callout).foregroundStyle(.secondary)
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

            if canAddToMine {
                Section {
                    Menu {
                        ForEach(ShowList.allCases) { l in
                            Button(l.title) { Task { await addToMyList(l) } }
                        }
                    } label: {
                        Label("Add to My List", systemImage: "plus.circle.fill")
                    }
                    .disabled(addingToMine)
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
        .alert(addAlert?.title ?? "",
               isPresented: Binding(get: { addAlert != nil }, set: { if !$0 { addAlert = nil } }),
               presenting: addAlert) { _ in
            Button("OK", role: .cancel) { }
        } message: { Text($0.message) }
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

    // Copy this show onto one of the logged-in member's lists. The POST is
    // session-scoped, so it lands on *my* lists regardless of whose show this is.
    private func addToMyList(_ list: ShowList) async {
        guard let s = show, let mine = auth.memberSlug else { return }
        addingToMine = true
        defer { addingToMine = false }
        do {
            _ = try await API.addShow(
                memberSlug: mine,
                title: s.title,
                network: s.network,
                networkUrl: s.networkUrl,
                list: list.rawValue,
                notes: nil,
                recommendedBy: nil,
                movie: s.isMovie,
                fullSeries: s.isFullSeries,
                watchingWith: nil
            )
            addAlert = AddAlert(title: "Added",
                                message: "“\(s.title)” was added to your \(list.title) list.")
        } catch API.APIError.badResponse(409) {
            addAlert = AddAlert(title: "Already on a list",
                                message: "“\(s.title)” is already on one of your lists.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t add",
                                message: "Something went wrong. Please try again.")
        }
    }
}

private struct AddAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}
