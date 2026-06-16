import SwiftUI

// Cross-library search: every active show across every member, filtered by
// title and/or actor (mirrors the web landing-page "Search all libraries").
// Logged-in members can copy a result onto one of their own lists.
struct SearchView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var all: [AllShow] = []
    @State private var loading = true
    @State private var titleQuery = ""
    @State private var actorQuery = ""
    @State private var addingId: Int?
    @State private var addAlert: SearchAlert?

    private var hasQuery: Bool {
        !titleQuery.trimmingCharacters(in: .whitespaces).isEmpty ||
        !actorQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var results: [AllShow] {
        let t = titleQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let a = actorQuery.trimmingCharacters(in: .whitespaces).lowercased()
        guard !t.isEmpty || !a.isEmpty else { return [] }
        return all.filter { s in
            let titleHit = t.isEmpty || s.title.lowercased().contains(t)
            let actorHit = a.isEmpty || s.actorNamesText.lowercased().contains(a)
            return titleHit && actorHit
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    TextField("Title — e.g. Fargo", text: $titleQuery)
                        .autocorrectionDisabled()
                    TextField("Actor — e.g. Billy Bob Thornton", text: $actorQuery)
                        .autocorrectionDisabled()
                }
                if loading {
                    Section { HStack { Spacer(); ProgressView(); Spacer() } }
                } else if !hasQuery {
                    Section {
                        Text("Type to search across every member's library.")
                            .foregroundStyle(.secondary)
                    }
                } else if results.isEmpty {
                    Section {
                        Text("No matches across club libraries.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("\(results.count) match\(results.count == 1 ? "" : "es")") {
                        ForEach(results) { resultRow($0) }
                    }
                }
            }
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
            .alert(addAlert?.title ?? "",
                   isPresented: Binding(get: { addAlert != nil }, set: { if !$0 { addAlert = nil } }),
                   presenting: addAlert) { _ in
                Button("OK", role: .cancel) { }
            } message: { Text($0.message) }
        }
    }

    @ViewBuilder private func resultRow(_ s: AllShow) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if auth.isLoggedIn {
                Menu {
                    ForEach(ShowList.allCases) { l in
                        Button(l.title) { Task { await addToMine(s, list: l) } }
                    }
                } label: {
                    Image(systemName: "plus.circle.fill").foregroundStyle(Color.accentColor)
                }
                .disabled(addingId == s.id)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.title).font(.body)
                    if s.isFullSeries { Text("🎬") }
                    if s.isMovie { Text("(Movie)").font(.caption).foregroundStyle(.secondary) }
                }
                HStack(spacing: 6) {
                    if let n = s.network, !n.isEmpty { Text(n) }
                    Text("· \(s.listLabel) · \(s.ownerLabel)")
                }
                .font(.caption).foregroundStyle(.secondary)
                if !s.genreList.isEmpty {
                    Text(s.genreList.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let r = s.rating, !r.isEmpty {
                Label(r, systemImage: "star.fill")
                    .font(.caption).labelStyle(.titleAndIcon).foregroundStyle(.orange)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        all = (try? await API.allShows()) ?? []
    }

    // Copy a search result onto one of my lists. Session-scoped POST, so it
    // lands on my library regardless of whose show this originally was.
    private func addToMine(_ s: AllShow, list: ShowList) async {
        guard let mine = auth.memberSlug else { return }
        addingId = s.id
        defer { addingId = nil }
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
            addAlert = SearchAlert(title: "Added",
                                   message: "“\(s.title)” was added to your \(list.title) list.")
        } catch API.APIError.badResponse(409) {
            addAlert = SearchAlert(title: "Already on a list",
                                   message: "“\(s.title)” is already on one of your lists.")
        } catch {
            addAlert = SearchAlert(title: "Couldn’t add",
                                   message: "Something went wrong. Please try again.")
        }
    }
}

private struct SearchAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}
