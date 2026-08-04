import SwiftUI

// Cross-library search: every active show across every member, filtered by
// title and/or actor (mirrors the web landing-page "Search all libraries").
// Logged-in members can copy a result onto one of their own lists.
struct SearchView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var all: [AllShow] = []
    @State private var loading = true
    // The library fetch threw — "No matches" must not show over a failed load.
    @State private var loadFailed = false
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
                } else if loadFailed {
                    Section {
                        Text("Couldn't load the club libraries.")
                            .foregroundStyle(.secondary)
                        Button("Try again") { Task { await load() } }
                    }
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

    // Tapping the row opens the full show card; the plus stays as a
    // quick-add shortcut (Menu swallows its own taps, so it doesn't navigate).
    @ViewBuilder private func resultRow(_ s: AllShow) -> some View {
        NavigationLink {
            ShowDetailView(id: s.id, initialTitle: s.title,
                           initialNetwork: s.network, initialRating: s.rating,
                           initialPoster: s.posterUrl, initialNetworkUrl: s.networkUrl)
        } label: {
            resultRowLabel(s)
        }
    }

    @ViewBuilder private func resultRowLabel(_ s: AllShow) -> some View {
        // Cross-library search adds two things to a plain row: the "+" that
        // copies a show onto one of my lists, and a caption naming which list
        // the copy is on and whose it is.
        ShowRow(
            s,
            caption: [s.network, "\(s.listLabel) · \(s.ownerLabel)"].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "),
            alignment: .top,
            leading: {
                if auth.isLoggedIn {
                    Menu {
                        ForEach(ShowList.allCases) { l in
                            Button(l.title) { Task { await addToMine(s, list: l) } }
                        }
                    } label: {
                        Image(systemName: "plus.circle.fill").foregroundStyle(Color.accentColor)
                    }
                    // Borderless so the plus keeps its own tap target inside
                    // the NavigationLink row instead of the tap navigating.
                    .buttonStyle(.borderless)
                    .disabled(addingId == s.id)
                }
            },
            extra: {
                if !s.genreList.isEmpty {
                    Text(s.genreList.joined(separator: " · "))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        )
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            all = try await API.allShows()
            loadFailed = false
        } catch {
            loadFailed = true
        }
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
        } catch let e as API.APIError where e.status == 409 {
            addAlert = SearchAlert(title: "Already on a list",
                                   message: "“\(s.title)” is already on one of your lists.")
        } catch let e as API.APIError where e.status == 401 {
            addAlert = SearchAlert(title: "Logged out",
                                   message: "Your session expired — sign in again from Home.")
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
