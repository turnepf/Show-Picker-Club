import SwiftUI

// Search within one member's library — including archived rows, which makes
// this the way to find (and, via the detail screen, restore) an archived
// show. Mirrors the web member-page search: title and actor filters, rows
// labeled with their list or "Archived".
struct MemberSearchView: View {
    let member: Member
    @Environment(\.dismiss) private var dismiss

    @State private var shows: [Show] = []
    @State private var loading = true
    // The library fetch threw — "No matches" must not show over a failed load.
    @State private var loadFailed = false
    @State private var titleQuery = ""
    @State private var actorQuery = ""

    private var hasQuery: Bool {
        !titleQuery.trimmingCharacters(in: .whitespaces).isEmpty ||
        !actorQuery.trimmingCharacters(in: .whitespaces).isEmpty
    }

    private var results: [Show] {
        let t = titleQuery.trimmingCharacters(in: .whitespaces).lowercased()
        let a = actorQuery.trimmingCharacters(in: .whitespaces).lowercased()
        guard !t.isEmpty || !a.isEmpty else { return [] }
        return shows.filter { s in
            let titleHit = t.isEmpty || s.title.lowercased().contains(t)
            let actorHit = a.isEmpty || s.castMembers.contains { $0.name.lowercased().contains(a) }
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
                } else if loadFailed {
                    Section {
                        Text("Couldn't load \(member.label)'s shows.")
                            .foregroundStyle(.secondary)
                        Button("Try again") { Task { await load() } }
                    }
                } else if !hasQuery {
                    Section {
                        Text("Search \(member.label)'s shows — archived ones too.")
                            .foregroundStyle(.secondary)
                    }
                } else if results.isEmpty {
                    Section {
                        Text("No matches, including archived shows.")
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Section("\(results.count) match\(results.count == 1 ? "" : "es")") {
                        ForEach(results) { resultRow($0) }
                    }
                }
            }
            .navigationTitle("\(member.label)'s Shows")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    @ViewBuilder private func resultRow(_ s: Show) -> some View {
        NavigationLink {
            ShowDetailView(id: s.id, initialTitle: s.title,
                           initialNetwork: s.network, initialRating: s.rating,
                           initialPoster: s.posterUrl, initialNetworkUrl: s.networkUrl)
        } label: {
            // Searching your own library turns up archived copies too, so the
            // caption names the list — in orange when the copy is archived.
            ShowRow(
                s,
                caption: [s.network, s.isArchived ? "Archived" : (ShowList(rawValue: s.list)?.title ?? s.list)]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
                captionTint: s.isArchived ? .orange : nil,
                alignment: .top
            )
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            shows = try await API.shows(member: member.slug, includeArchived: true)
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }
}
