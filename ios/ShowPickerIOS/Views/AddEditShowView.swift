import SwiftUI

// Sheet for adding a new show or editing an existing one. Standard Form
// layout with system controls — Section / TextField / Picker / Toggle.
struct AddEditShowView: View {
    let memberSlug: String
    let existing: Show?
    // Which list a brand-new show lands on before the member touches the
    // picker. The caller passes the list currently on screen, so tapping "+"
    // while looking at Awaiting adds to Awaiting — not silently to Watching.
    // Ignored when editing: an existing row seeds from its own list.
    var initialList: ShowList = .watching
    let onSave: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var network = ""
    // Free-text network for anything outside the canonical list. Selecting
    // "Network not listed…" reveals the field; an existing row whose network
    // isn't canonical (set on the web, or inherited from enrichment) opens
    // straight into it rather than silently losing its value to the picker.
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
    @State private var archived = false
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
                    Picker("Network", selection: $network) {
                        Text("None").tag("")
                        ForEach(CANONICAL_NETWORKS, id: \.self) { n in
                            Text(n).tag(n)
                        }
                        // The canonical list covers the services the club
                        // actually uses; anything else (a regional channel,
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
                    if existing != nil {
                        Toggle("Archived", isOn: $archived)
                    }
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle(existing == nil ? "Add Show" : "Edit Show")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Add" : "Save") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .interactiveDismissDisabled(saving)
            .onAppear(perform: prefill)
            .task { await loadGroupMates() }
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
        // Just picked (or unchanged existing title) — nothing to suggest.
        if let p = picked, p.title == q { titleHits = []; return }
        picked = nil
        if let s = existing, s.title == q { titleHits = []; return }
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

    // Whether the row we're editing told us who it names. A new show knows by
    // definition (nobody, until the member picks). An existing one knows only
    // if it arrived with a `watchers` array — absent means "this payload
    // predates links", not "no one is linked", and the two must not be
    // confused on save.
    private var watchersKnown: Bool {
        guard let s = existing else { return true }
        return s.watchers != nil
    }

    // Which group someone is in only explains anything when there's more than
    // one group they could have come from. In a club where everyone shares the
    // same single group, the caption is the same word under every name.
    private var showsGroupNames: Bool {
        Set(groupMates.flatMap { $0.groups ?? [] }).count > 1
    }

    // "Whitt's", "Amy and Whitt's" — whose lists this save is about to touch,
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
        // A show can name someone the owner has since left the group with.
        // Their link is still real, so keep them selectable rather than
        // silently dropping them on the next save.
        let linked = existing?.watchers ?? []
        let missing = linked.filter { l in !mates.contains(where: { $0.slug == l.slug }) }
        groupMates.append(contentsOf: missing.map { GroupMate(slug: $0.slug, name: $0.name, groups: nil) })
    }

    private func prefill() {
        guard let s = existing else { list = initialList; return }
        title = s.title
        let existingNetwork = s.network ?? ""
        if !existingNetwork.isEmpty && !CANONICAL_NETWORKS.contains(existingNetwork) {
            customNetwork = existingNetwork
            network = Self.otherNetworkTag
        } else {
            network = existingNetwork
        }
        list = ShowList(rawValue: s.list) ?? .watching
        notes = s.notes ?? ""
        recommendedBy = s.recommendedBy ?? ""
        // The stored field is the composed string — free text plus the linked
        // members' names. Show only the free half here; the names are the
        // ticked pickers above, and leaving them in the box would save them a
        // second time as literal text.
        let linked = s.watchers ?? []
        selectedWatchers = Set(linked.map(\.slug))
        watchingWith = Self.freeText(from: s.watchingWith, minus: linked.map(\.name))
        movie = s.isMovie
        fullSeries = s.isFullSeries
        archived = s.isArchived
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
        // The complete set, so unticking someone unlinks them — an empty array
        // is a real instruction ("nobody"), not an omission.
        //
        // Except when we don't actually know the current set: a row decoded
        // from an offline cache written before links existed has no
        // `watchers`, so the pickers open with nothing ticked whether or not
        // anyone is really linked. Sending [] there would silently unlink
        // people the member never saw, over an edit to some other field. nil
        // omits the key and the server leaves the links alone. Ticking
        // somebody is a real instruction either way and always sends.
        let watchers: [String]? = (watchersKnown || !selectedWatchers.isEmpty)
            ? Array(selectedWatchers) : nil
        // Only send the pick while the field still holds the picked title —
        // hand-edits after picking fall back to title-search enrichment.
        let pin = (picked?.title == t) ? picked : nil
        do {
            if let s = existing {
                _ = try await API.updateShow(id: s.id, title: t, network: net, list: list.rawValue,
                                             notes: n, recommendedBy: rec, movie: movie,
                                             fullSeries: fullSeries, watchingWith: ww,
                                             watcherSlugs: watchers, archived: archived,
                                             memberSlug: memberSlug,
                                             tmdbId: pin?.tmdbId, tmdbType: pin?.mediaType)
            } else {
                // Mirror the web's pre-save dedupe: an active copy blocks with
                // a pointer to its list, an archived copy offers a restore.
                // Offline (check unreachable) falls through to the queued add.
                if let dup = try? await API.checkShow(title: t, member: memberSlug), dup.exists {
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
            }
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
                errorText = rej.status == 401
                    ? "Couldn't save — you're logged out. Sign in again from Home."
                    : "Couldn't save. Try again."
            }
        } catch let e as API.APIError where e.status == 401 {
            errorText = "Couldn't save — you're logged out. Sign in again from Home."
        } catch {
            errorText = "Couldn't save. Check your connection and try again."
        }
    }

    // The half of the composed "Watching with" string that isn't a linked
    // member's name. The mirror of composeWatchingWith() in
    // functions/_shared/watchers.js: the field is comma-joined, so a name is
    // one whole part, matched without regard to case or padding. Anything
    // that isn't a linked name is the member's own text and comes back
    // untouched, in the order they typed it.
    static func freeText(from composed: String?, minus names: [String]) -> String {
        guard let composed, !composed.isEmpty else { return "" }
        let linked = Set(names.map { $0.trimmingCharacters(in: .whitespaces).lowercased() })
        return composed
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !linked.contains($0.lowercased()) }
            .joined(separator: ", ")
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
