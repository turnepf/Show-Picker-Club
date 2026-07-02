import SwiftUI

struct ShowDetailView: View {
    let id: Int?
    let initialTitle: String
    let initialNetwork: String?
    let initialRating: String?
    var initialPoster: String? = nil
    var initialNetworkUrl: String? = nil

    @EnvironmentObject private var auth: AuthStore
    @State private var show: Show?
    // My own copy of this title (active or archived), resolved on load so the
    // actions and the List row reflect MY row — not the copy that search may
    // have opened by id.
    @State private var myCopy: Show?
    @State private var cast: [Actor] = []
    @State private var showingEdit = false
    @State private var showingShare = false
    @State private var posterExpanded = false
    @State private var addingToMine = false
    @State private var addAlert: AddAlert?
    @Environment(\.openURL) private var openURL

    private var title: String { show?.title ?? initialTitle }
    private var network: String? { show?.network ?? initialNetwork }
    private var rating: String? { show?.rating ?? initialRating }
    // My active copy of this title, if it's on one of my lists.
    private var mineActive: Show? {
        guard let m = myCopy, !m.isArchived else { return nil }
        return m
    }
    // My archived copy of this title, if I've shelved it.
    private var mineArchived: Show? {
        guard let m = myCopy, m.isArchived else { return nil }
        return m
    }

    var body: some View {
        Form {
            if let p = (show?.posterUrl ?? initialPoster), !p.isEmpty {
                Section {
                    // Tap to view the poster full screen; tap again to return.
                    Button { posterExpanded = true } label: {
                        PosterThumb(url: p, width: 130, height: 195)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
                }
            }
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
                    if let m = mineActive {
                        LabeledContent("List", value: ShowList(rawValue: m.list)?.title ?? m.list.capitalized)
                    } else if mineArchived != nil {
                        LabeledContent("List", value: "Archived")
                    }
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
                    if let seasons = s.seasonsText {
                        LabeledContent("Seasons", value: seasons)
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

            if let m = mineActive, let cur = ShowList(rawValue: m.list) {
                // On one of my lists → move it to any list, or archive it.
                Section("Move to") {
                    ForEach(ShowList.allCases.filter { $0 != cur }) { l in
                        Button(l.title) { Task { await move(to: l, id: m.id) } }
                    }
                }
                Section {
                    Button(role: .destructive) { Task { await archive(m.id) } } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .disabled(addingToMine)
                }
            } else if let m = mineArchived {
                // Archived → add it back onto any list.
                Section("Archived — add back to") {
                    ForEach(ShowList.allCases) { l in
                        Button(l.title) { Task { await restore(to: l, id: m.id) } }
                    }
                }
            } else if auth.memberSlug != nil {
                // Not on my lists → add to any list.
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

            // Send the whole show (rating, network link, cast, flags) to another
            // member's Up Next. Available on any real member's show when logged in.
            if auth.isLoggedIn, let s = show, s.memberSlug != nil {
                Section {
                    Button {
                        showingShare = true
                    } label: {
                        Label("Send to a member", systemImage: "paperplane.fill")
                    }
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Standard iOS share sheet — text, mail, AirDrop, anything the
            // user has. Shares a watch link (or the club page) plus a blurb.
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: shareURL,
                          subject: Text(title),
                          message: Text(shareText)) {
                    Image(systemName: "square.and.arrow.up")
                }
            }
            if myCopy != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Edit") { showingEdit = true }
                }
            }
        }
        .task { await load() }
        .fullScreenCover(isPresented: $posterExpanded) {
            if let p = (show?.posterUrl ?? initialPoster), !p.isEmpty {
                FullScreenPoster(url: p)
            }
        }
        .sheet(isPresented: $showingEdit) {
            if let m = myCopy {
                AddEditShowView(memberSlug: m.memberSlug ?? (auth.memberSlug ?? ""), existing: m) { await load() }
            }
        }
        .sheet(isPresented: $showingShare) {
            if let s = show, let owner = s.memberSlug {
                ShareShowView(showId: s.id, showTitle: s.title, sourceMember: owner)
                    .environmentObject(auth)
            }
        }
        .alert(addAlert?.title ?? "",
               isPresented: Binding(get: { addAlert != nil }, set: { if !$0 { addAlert = nil } }),
               presenting: addAlert) { _ in
            Button("OK", role: .cancel) { }
        } message: { Text($0.message) }
    }

    // What the share sheet hands off. Prefer a real deep link so the
    // recipient lands on the show itself; otherwise fall back to the
    // owner's club page so the link still goes somewhere useful.
    private var shareURL: URL {
        if let u = show?.networkUrl, isRealUrl(u), let url = URL(string: u) {
            return url
        }
        let slug = show?.memberSlug ?? ""
        return URL(string: "https://showpicker.club/\(slug)")
            ?? URL(string: "https://showpicker.club")!
    }

    private var shareText: String {
        let place = (network.map { " on \($0)" }) ?? ""
        return "Check out \(title)\(place) — from Show Picker Club"
    }

    private func isRealUrl(_ u: String) -> Bool {
        let l = u.lowercased()
        if l.isEmpty || l == "#" { return false }
        return !(l.contains("/search") || l.contains("/s?") || l.contains("?q=") || l.contains("?query="))
    }

    private func load() async {
        if let id {
            if let s = try? await API.showDetail(id: id) { show = s }
            cast = (try? await API.actors(showId: id)) ?? []
        }
        await refreshMyCopy()
    }

    // Find my own row for this title (active or archived) so the actions and
    // the List row reflect MY copy, regardless of whose copy opened the screen.
    private func refreshMyCopy() async {
        guard let mine = auth.memberSlug else { myCopy = nil; return }
        let t = (show?.title ?? initialTitle).lowercased()
        let list = (try? await API.shows(member: mine, includeArchived: true)) ?? []
        myCopy = list.first { $0.title.lowercased() == t }
    }

    private func move(to list: ShowList, id: Int) async {
        do {
            try await API.moveShow(id: id, to: list.rawValue)
            await refreshMyCopy()
        } catch {
            addAlert = AddAlert(title: "Couldn’t move",
                                message: "Something went wrong. Please try again.")
        }
    }

    private func archive(_ id: Int) async {
        do {
            try await API.archiveShow(id: id)
            await refreshMyCopy()
        } catch {
            addAlert = AddAlert(title: "Couldn’t archive",
                                message: "Something went wrong. Please try again.")
        }
    }

    private func restore(to list: ShowList, id: Int) async {
        do {
            try await API.restoreShow(id: id, to: list.rawValue)
            await refreshMyCopy()
            addAlert = AddAlert(title: "Added back",
                                message: "“\(title)” was added to your \(list.title) list.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t restore",
                                message: "Something went wrong. Please try again.")
        }
    }

    // Copy this show onto one of the logged-in member's lists. The POST is
    // session-scoped, so it lands on *my* lists regardless of whose show this is.
    private func addToMyList(_ list: ShowList) async {
        guard let mine = auth.memberSlug else { return }
        // Works from a loaded show or a recommendation (no `show` yet).
        let addTitle = show?.title ?? initialTitle
        addingToMine = true
        defer { addingToMine = false }
        do {
            _ = try await API.addShow(
                memberSlug: mine,
                title: addTitle,
                network: show?.network ?? initialNetwork,
                networkUrl: show?.networkUrl ?? initialNetworkUrl,
                list: list.rawValue,
                notes: nil,
                recommendedBy: nil,
                movie: show?.isMovie ?? false,
                fullSeries: show?.isFullSeries ?? false,
                watchingWith: nil
            )
            addAlert = AddAlert(title: "Added",
                                message: "“\(addTitle)” was added to your \(list.title) list.")
            await refreshMyCopy()
        } catch API.APIError.badResponse(409) {
            // Already have it (maybe archived) — reconcile so the right
            // controls appear.
            await refreshMyCopy()
            addAlert = AddAlert(title: mineArchived != nil ? "Archived" : "Already on a list",
                                message: mineArchived != nil
                                    ? "“\(addTitle)” is archived — use “add back to” below."
                                    : "“\(addTitle)” is already on one of your lists.")
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
