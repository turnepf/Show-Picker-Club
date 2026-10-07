import SwiftUI

// Sheet for adding a new show. Standard Form layout with system controls —
// Section / TextField / Picker / Toggle. Add only, despite the name: there's
// no edit screen any more. Title, service and the catalog facts are TMDB's,
// and the two memos a member still writes (Watching With, Notes) are edited
// in place on the show card (ShowDetailView); ratings are rated there too.
struct AddEditShowView: View {
    let memberSlug: String
    // Which list a brand-new show lands on before the member touches the
    // picker. The caller passes the list currently on screen, so tapping "+"
    // while looking at Awaiting adds to Awaiting — not silently to Watching.
    var initialList: ShowList = .watching
    // Opened from Find a Show: the title typed there, and the TMDB entry the
    // member tapped (pinned, exactly as if picked from the type-ahead here).
    var initialTitle: String? = nil
    var initialPick: TitleHit? = nil
    let onSave: () async -> Void

    @Environment(\.dismiss) private var dismiss
    // The picker's contents, fetched and cached rather than compiled in, so a
    // network added on the server reaches this build.
    @ObservedObject private var catalog = NetworkCatalogStore.shared
    @State private var title = ""
    @State private var network = ""
    // Free-text network for anything outside the canonical list. Selecting
    // "Network not listed…" reveals the field.
    @State private var customNetwork = ""
    private static let otherNetworkTag = "__other"
    @State private var list: ShowList = .watching
    @State private var notes = ""
    @State private var recommendedBy = ""
    // "Watching with" is two things at once: club members you share a group
    // with (`selectedWatchers` — picking one links your libraries and puts the
    // title on their list too) and anyone else (`watchingWith`, still free
    // text). The server composes the two into the single display string the
    // field has always been; this view keeps them apart while editing so the
    // text box doesn't fill up with names the pickers already show.
    @State private var watchingWith = ""
    @State private var groupMates: [GroupMate] = []
    @State private var selectedWatchers: Set<String> = []
    @State private var movie = false
    @State private var fullSeries = false
    @State private var saving = false
    @State private var errorText: String?
    // Type-ahead: matching TMDB titles for what's typed, and the member's
    // exact pick (pinned through save so enrichment can't mismatch).
    @State private var titleHits: [TitleHit] = []
    @State private var picked: TitleHit?
    // Pre-save dedupe (add only): an archived copy of the typed title offers
    // a restore instead of creating a duplicate row.
    @State private var restoreId: Int?
    @State private var showingRestorePrompt = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)
                        .task(id: title) { await searchTitles() }
                    ForEach(titleHits) { hit in
                        Button { pick(hit) } label: { TitleHitRow(hit: hit) }
                            .buttonStyle(.plain)
                    }
                    // Sections and their order are the server's (see
                    // NetworkCatalogStore): the regional services are grouped
                    // under their own headers rather than interleaved, because
                    // most of the club will never pick from them and merging
                    // would put 9Now and Channel 4 ahead of the services
                    // everyone uses. Rows show the canonical name; the server's
                    // longer `display` carries sub-brand hints that suit a web
                    // <select> and overflow a menu row here.
                    Picker("Network", selection: $network) {
                        Text("None").tag("")
                        ForEach(catalog.sections) { section in
                            if let title = section.title {
                                Section(title) {
                                    ForEach(section.options) { option in
                                        Text(option.stored).tag(option.stored)
                                    }
                                }
                            } else {
                                ForEach(section.options) { option in
                                    Text(option.stored).tag(option.stored)
                                }
                            }
                        }
                        // Anything the list doesn't carry (a regional channel,
                        // a sports tier) was simply unenterable before. The
                        // server canonicalizes what it recognizes and keeps
                        // the rest as typed.
                        Text("Network not listed…").tag(Self.otherNetworkTag)
                    }
                    if network == Self.otherNetworkTag {
                        TextField("Network name", text: $customNetwork)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.words)
                    }
                } footer: {
                    if !titleHits.isEmpty {
                        Text("Tap your show to fill in the exact title — poster, rating, and cast come with it.")
                    }
                }
                Section("List") {
                    Picker("List", selection: $list) {
                        ForEach(ShowList.allCases) { l in Text(l.title).tag(l) }
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    TextField("Recommended by", text: $recommendedBy)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    ForEach(groupMates) { mate in
                        Button {
                            if selectedWatchers.contains(mate.slug) { selectedWatchers.remove(mate.slug) }
                            else { selectedWatchers.insert(mate.slug) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(mate.name)
                                    if showsGroupNames, let g = mate.groupsLabel {
                                        Text(g).font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if selectedWatchers.contains(mate.slug) {
                                    Image(systemName: "checkmark").foregroundStyle(.tint)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    TextField(groupMates.isEmpty ? "Watching with" : "Someone else", text: $watchingWith)
                } header: {
                    Text("Watching with")
                } footer: {
                    if !groupMates.isEmpty { Text(watchersFooter) }
                }
                Section {
                    Toggle("Movie", isOn: $movie)
                    Toggle("Series complete", isOn: $fullSeries)
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add Show")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .interactiveDismissDisabled(saving)
            .onAppear(perform: prefill)
            .task { await loadGroupMates() }
            // Every time the sheet opens, not once per launch: the cached
            // list is the fallback for a pull that fails, not a reason to skip
            // one. An unchanged list answers 304, and a failure leaves what's
            // already loaded on screen.
            .task { await catalog.refresh() }
            .overlay { if saving { ProgressView().controlSize(.large) } }
            .alert("Already in your archive", isPresented: $showingRestorePrompt) {
                Button("Add back to \(list.title)") { Task { await restoreArchived() } }
                Button("Cancel", role: .cancel) { restoreId = nil }
            } message: {
                Text("“\(title.trimmingCharacters(in: .whitespaces))” is in your archive. Restore it to \(list.title) instead of adding a duplicate?")
            }
        }
    }

    // Debounced TMDB lookup for the typed title. .task(id: title) cancels the
    // in-flight search on every keystroke, so only the pause-after-typing one
    // actually hits the network.
    private func searchTitles() async {
        let q = title.trimmingCharacters(in: .whitespaces)
        // Just picked — nothing to suggest.
        if let p = picked, p.title == q { titleHits = []; return }
        picked = nil
        guard q.count >= 2 else { titleHits = []; return }
        try? await Task.sleep(nanoseconds: 300_000_000)
        if Task.isCancelled { return }
        let hits = (try? await API.titleSearch(q)) ?? []
        if !Task.isCancelled { titleHits = hits }
    }

    private func pick(_ hit: TitleHit) {
        picked = hit
        title = hit.title
        movie = hit.isMovie
        titleHits = []
    }

    // Which group someone is in only explains anything when there's more than
    // one group they could have come from. In a club where everyone shares the
    // same single group, the caption is the same word under every name.
    private var showsGroupNames: Bool {
        Set(groupMates.flatMap { $0.groups ?? [] }).count > 1
    }

    // "Quinn's", "Amy and Quinn's" — whose lists this save is about to touch,
    // in the order the pickers are drawn.
    private var watcherNames: String {
        let names = groupMates.filter { selectedWatchers.contains($0.slug) }.map(\.name)
        guard let last = names.last else { return "their" }
        let joined = names.count > 1
            ? names.dropLast().joined(separator: ", ") + " and " + last
            : last
        return joined + "’s"
    }

    // Says plainly what picking someone does, because it does something to
    // another person's library and that shouldn't be a surprise after the
    // fact.
    private var watchersFooter: String {
        if selectedWatchers.isEmpty {
            return "Pick anyone you share a group with — the show goes on their list too, and their copy names you back. Anyone else, just type."
        }
        let trimmed = title.trimmingCharacters(in: .whitespaces)
        let subject = trimmed.isEmpty ? "This show" : "“\(trimmed)”"
        let lists = selectedWatchers.count > 1 ? "lists" : "list"
        return "\(subject) will be added to \(watcherNames) \(lists) too. If they already have it, it stays where they put it."
    }

    // Members in no shared group get no pickers at all — there is nobody they
    // could name — and the section collapses to the plain text field it has
    // always been. A failed fetch lands in the same place, which is the right
    // failure: the free text still saves.
    private func loadGroupMates() async {
        guard let mates = try? await API.groupMates() else { return }
        groupMates = mates
    }

    private func prefill() {
        list = initialList
        // Seed once: a title already in the field is the member's.
        if title.isEmpty {
            if let hit = initialPick {
                pick(hit)
            } else if let t = initialTitle {
                title = t
            }
        }
    }

    private func save() async {
        saving = true
        errorText = nil
        defer { saving = false }
        let t = title.trimmingCharacters(in: .whitespaces)
        let chosen = network == Self.otherNetworkTag
            ? customNetwork.trimmingCharacters(in: .whitespaces)
            : network
        let net = chosen.isEmpty ? nil : chosen
        let n = notes.trimmingCharacters(in: .whitespaces).isEmpty ? nil : notes
        let rec = recommendedBy.trimmingCharacters(in: .whitespaces).isEmpty ? nil : recommendedBy
        let ww = watchingWith.trimmingCharacters(in: .whitespaces).isEmpty ? nil : watchingWith
        // A new show names nobody until the member picks, so the set is
        // always known and always sent.
        let watchers: [String]? = Array(selectedWatchers)
        // Only send the pick while the field still holds the picked title —
        // hand-edits after picking fall back to title-search enrichment.
        let pin = (picked?.title == t) ? picked : nil
        do {
            // Mirror the web's pre-save dedupe: an active copy blocks with
            // a pointer to its list, an archived copy offers a restore.
            // Offline (check unreachable) falls through to the queued add.
            if let dup = try? await API.checkShow(title: t, member: memberSlug,
                                                     tmdbId: pin?.tmdbId, tmdbType: pin?.mediaType), dup.exists {
                if dup.archived == true, let id = dup.id {
                    restoreId = id
                    showingRestorePrompt = true
                    return
                }
                let listName = dup.list.flatMap { ShowList(rawValue: $0)?.title } ?? "one of your lists"
                errorText = "“\(t)” is already on \(listName == "one of your lists" ? listName : "your \(listName) list")."
                return
            }
            _ = try await API.addShow(memberSlug: memberSlug, title: t, network: net, list: list.rawValue,
                                      notes: n, recommendedBy: rec, movie: movie,
                                      fullSeries: fullSeries, watchingWith: ww,
                                      watcherSlugs: watchers,
                                      tmdbId: pin?.tmdbId, tmdbType: pin?.mediaType)
            await onSave()
            dismiss()
        } catch let API.APIError.rejected(rej) {
            // The server dedupes against the canonical (TMDB) title, which can
            // differ from what was typed — so a duplicate can slip past the
            // pre-save check above and come back as a 409 here.
            switch rej.code {
            case "exists_archived" where rej.id != nil:
                if let canon = rej.title { title = canon }
                restoreId = rej.id
                showingRestorePrompt = true
            case "exists_active":
                let canon = rej.title ?? t
                let listName = rej.list.flatMap { ShowList(rawValue: $0)?.title }
                errorText = "“\(canon)” is already on \(listName.map { "your \($0) list" } ?? "one of your lists")."
            case "rate_limited":
                errorText = "Daily add limit reached. Try again tomorrow."
            default:
                // no_match / tmdb_unavailable: the server's own sentence says
                // whether to fix the title or try again later.
                errorText = rej.status == 401
                    ? "Couldn't save — you're logged out. Sign in again from Home."
                    : (rej.message ?? "Couldn't save. Try again.")
            }
        } catch let e as API.APIError where e.status == 401 {
            errorText = "Couldn't save — you're logged out. Sign in again from Home."
        } catch {
            errorText = "Couldn't save. Check your connection and try again."
        }
    }

    private func restoreArchived() async {
        guard let id = restoreId else { return }
        saving = true
        defer { saving = false }
        do {
            try await API.restoreShow(id: id, to: list.rawValue)
            await onSave()
            dismiss()
        } catch let e as API.APIError where e.status == 401 {
            errorText = "Couldn't restore — you're logged out. Sign in again from Home."
        } catch {
            errorText = "Couldn't restore. Check your connection and try again."
        }
    }
}
