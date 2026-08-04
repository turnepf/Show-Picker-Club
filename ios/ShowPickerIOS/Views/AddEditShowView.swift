import SwiftUI

// Sheet for adding a new show or editing an existing one. Standard Form
// layout with system controls — Section / TextField / Picker / Toggle.
struct AddEditShowView: View {
    let memberSlug: String
    let existing: Show?
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
    @State private var watchingWith = ""
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
                    TextField("Watching with", text: $watchingWith)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
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

    private func prefill() {
        guard let s = existing else { return }
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
        watchingWith = s.watchingWith ?? ""
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
        // Only send the pick while the field still holds the picked title —
        // hand-edits after picking fall back to title-search enrichment.
        let pin = (picked?.title == t) ? picked : nil
        do {
            if let s = existing {
                _ = try await API.updateShow(id: s.id, title: t, network: net, list: list.rawValue,
                                             notes: n, recommendedBy: rec, movie: movie,
                                             fullSeries: fullSeries, watchingWith: ww, archived: archived,
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
