import SwiftUI

// Operator tool: titles still on a placeholder network URL. Tap one to paste a
// real deep link, or fix a wrong/typo'd title. POST /api/admin-url-cleanup.
struct UrlCleanupView: View {
    @State private var items: [UrlQueueItem] = []
    @State private var networks: [String] = []
    @State private var conflicts: [UrlConflict] = []
    @State private var mismatches: [UrlMismatch] = []
    @State private var needsPoster: [NeedsPosterItem] = []
    @State private var loading = true
    @State private var working = false
    @State private var banner: String?

    var body: some View {
        List {
            // What's left to do, before any of the queues — the same summary
            // line the web puts at the top.
            Section {
                Text(remainingLine)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button {
                    Task { await runInherit() }
                } label: {
                    Label("Adopt networks from club copies", systemImage: "arrow.triangle.merge")
                }
                .disabled(working)
                Button {
                    Task { await runEnrichPasses() }
                } label: {
                    Label("Run enrichment passes", systemImage: "sparkles")
                }
                .disabled(working)
                if let b = banner {
                    Text(b).font(.caption).foregroundStyle(b.hasPrefix("✓") ? .green : .red)
                }
            } footer: {
                Text("Adopting copies the real link a sibling copy already has onto rows stuck on a placeholder. Enrichment runs up to five club-wide passes for posters, logos, seasons and dates.")
            }

            Section {
                if items.isEmpty && !loading {
                    Text("Queue is clear 🎉").foregroundStyle(.secondary)
                } else {
                    ForEach(items) { item in
                        NavigationLink {
                            UrlCleanupItemView(item: item, networks: networks) { await load() }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.body)
                                Text("\(item.network ?? "no network") · \(item.members ?? "")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            } header: {
                Text("Missing links")
            } footer: {
                Text("Titles whose only link is a search-page placeholder.")
            }

            if !conflicts.isEmpty {
                Section {
                    ForEach(conflicts) { c in
                        NavigationLink {
                            ConflictResolveView(conflict: c, networks: networks) { await load() }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(c.title).font(.body)
                                Text(c.networks.joined(separator: " vs "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Network conflicts")
                } footer: {
                    Text("Members carry these titles on different services. Pick the canonical one.")
                }
            }

            if !mismatches.isEmpty {
                Section {
                    ForEach(mismatches) { m in
                        MismatchRow(mismatch: m) { await load() }
                    }
                } header: {
                    Text("URL / network mismatches")
                } footer: {
                    Text("The link's domain disagrees with the stored network. Keep whichever is right.")
                }
            }

            if !needsPoster.isEmpty {
                Section {
                    ForEach(needsPoster) { item in
                        NavigationLink {
                            NeedsPosterItemView(item: item) { await load() }
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.title).font(.body)
                                Text([item.isMovie ? "Movie" : "TV series", item.members]
                                        .compactMap { $0 }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } header: {
                    Text("Missing posters")
                } footer: {
                    Text("No copy of these titles has a poster — usually a typo, a member-entered name, or a title TMDB only indexes under the other media type. The link queue misses them because their URL may be fine.")
                }
            }
        }
        .navigationTitle("Show Cleanup")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    private var remainingLine: String {
        let parts = [
            "\(items.count) show\(items.count == 1 ? "" : "s") remaining",
            needsPoster.isEmpty ? nil : "\(needsPoster.count) missing poster\(needsPoster.count == 1 ? "" : "s")",
            conflicts.isEmpty ? nil : "\(conflicts.count) conflict\(conflicts.count == 1 ? "" : "s")",
            mismatches.isEmpty ? nil : "\(mismatches.count) mismatch\(mismatches.count == 1 ? "" : "es")",
        ].compactMap { $0 }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        if let r = try? await API.urlCleanupQueue() {
            items = r.shows
            networks = r.networks
            conflicts = r.conflicts ?? []
            mismatches = r.mismatches ?? []
            needsPoster = r.needsPoster ?? []
        }
    }

    private func runInherit() async {
        working = true
        defer { working = false }
        do {
            let r = try await API.inheritNetworks()
            banner = r.error.map { "⚠︎ \($0)" } ?? "✓ Adopted links from club copies."
        } catch {
            banner = "⚠︎ " + API.failureLine(error, action: "adopt networks")
        }
        await load()
    }

    // Five passes, the same cap the web button uses: one call covers a batch,
    // and the queue rotates oldest-enriched-first, so repeats reach further.
    private func runEnrichPasses() async {
        working = true
        defer { working = false }
        var passes = 0
        for _ in 0..<5 {
            guard (try? await API.enrich()) != nil else { break }
            passes += 1
            banner = "Running enrichment… pass \(passes) of 5"
        }
        banner = passes > 0
            ? "✓ Ran \(passes) enrichment pass\(passes == 1 ? "" : "es")."
            : "⚠︎ Enrichment didn't run — try again."
        await load()
    }
}

// One title nothing has a poster for. Re-enrich it as-is, flip the media type
// TMDB indexed it under, or rename it and re-enrich — the three fixes the web
// panel offers, and the only ones that ever work for these.
private struct NeedsPosterItemView: View {
    let item: NeedsPosterItem
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var newTitle: String
    @State private var isMovie: Bool
    @State private var working = false
    @State private var banner: String?

    init(item: NeedsPosterItem, onChange: @escaping () async -> Void) {
        self.item = item
        self.onChange = onChange
        _newTitle = State(initialValue: item.title)
        _isMovie = State(initialValue: item.isMovie)
    }

    var body: some View {
        Form {
            Section("Show") {
                LabeledContent("Title", value: item.title)
                if let m = item.members, !m.isEmpty {
                    LabeledContent("On the lists of", value: m)
                }
            }

            Section {
                Picker("Media type", selection: $isMovie) {
                    Text("TV series").tag(false)
                    Text("Movie").tag(true)
                }
                .pickerStyle(.segmented)
                Button("Re-enrich") { Task { await reEnrich() } }
                    .disabled(working)
            } header: {
                Text("Look it up again")
            } footer: {
                Text("Fetches the title as it stands. Flip the media type first when TMDB only indexes it as the other one — that alone fixes most of these.")
            }

            Section {
                TextField("Corrected title", text: $newTitle)
                    .autocorrectionDisabled()
                Button("Rename & re-enrich") { Task { await rename() } }
                    .disabled(working || newTitle.trimmingCharacters(in: .whitespaces).isEmpty
                              || newTitle == item.title)
            } header: {
                Text("Or fix the title")
            } footer: {
                Text("Renames every copy, then re-enriches. For a typo that stuck, or a descriptive name a member typed.")
            }

            if let b = banner {
                Section { Text(b).foregroundStyle(b.hasPrefix("✓") ? .green : .red) }
            }
        }
        .navigationTitle("Missing poster")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if working { ProgressView().controlSize(.large) } }
    }

    private func reEnrich() async {
        working = true
        defer { working = false }
        do {
            let r = try await API.reEnrichShow(id: item.id, movie: isMovie)
            if let e = r.error {
                banner = "⚠︎ \(e)"
            } else {
                banner = "✓ Re-enriched."
                await onChange()
                dismiss()
            }
        } catch {
            banner = "⚠︎ " + API.failureLine(error, action: "re-enrich \(item.title)")
        }
    }

    private func rename() async {
        working = true
        defer { working = false }
        let t = newTitle.trimmingCharacters(in: .whitespaces)
        do {
            let r = try await API.fixShowTitle(id: item.id, newTitle: t)
            if let e = r.error {
                banner = "⚠︎ \(e)"
            } else {
                banner = "✓ Renamed and re-enriched."
                await onChange()
                dismiss()
            }
        } catch {
            banner = "⚠︎ " + API.failureLine(error, action: "rename \(item.title)")
        }
    }
}

// Pick a canonical network for a title members disagree on.
private struct ConflictResolveView: View {
    let conflict: UrlConflict
    let networks: [String]
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var network: String
    @State private var working = false
    @State private var banner: String?

    init(conflict: UrlConflict, networks: [String], onChange: @escaping () async -> Void) {
        self.conflict = conflict
        self.networks = networks
        self.onChange = onChange
        _network = State(initialValue: conflict.networks.first ?? "")
    }

    var body: some View {
        Form {
            Section("Show") {
                LabeledContent("Title", value: conflict.title)
                LabeledContent("Carried on", value: conflict.networks.joined(separator: ", "))
            }
            Section {
                Picker("Canonical network", selection: $network) {
                    ForEach(mergedNetworks, id: \.self) { Text($0).tag($0) }
                }
                Button("Set for all copies") { Task { await resolve() } }
                    .disabled(network.isEmpty || working)
            } footer: {
                Text("Every active copy of this title is set to the chosen network; wrong-network links are cleared for the next fill pass.")
            }
            if let b = banner {
                Section { Text(b).foregroundStyle(b.hasPrefix("✓") ? .green : .red) }
            }
        }
        .navigationTitle("Conflict")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if working { ProgressView().controlSize(.large) } }
    }

    // The conflicting networks first, then any other canonical ones.
    private var mergedNetworks: [String] {
        conflict.networks + CANONICAL_NETWORKS.filter { !conflict.networks.contains($0) }
    }

    private func resolve() async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await API.resolveUrlConflict(title: conflict.title, network: network)
            if let e = r.error { banner = e }
            else {
                banner = "✓ Updated \(r.updated ?? 0) cop\((r.updated ?? 0) == 1 ? "y" : "ies")"
                await onChange()
                try? await Task.sleep(nanoseconds: 700_000_000)
                dismiss()
            }
        } catch { banner = "Network error. Try again." }
    }
}

// One mismatched row with inline keep-url / keep-network actions.
private struct MismatchRow: View {
    let mismatch: UrlMismatch
    let onChange: () async -> Void
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(mismatch.title).font(.body)
            Text("Stored: \(mismatch.network) · URL says: \(mismatch.urlNetwork) · \(mismatch.member)")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Keep \(mismatch.urlNetwork)") { Task { await fix(keep: "url") } }
                    .buttonStyle(.bordered)
                Button("Keep \(mismatch.network)") { Task { await fix(keep: "network") } }
                    .buttonStyle(.bordered)
            }
            .font(.caption)
            .disabled(working)
        }
        .padding(.vertical, 2)
    }

    private func fix(keep: String) async {
        working = true
        defer { working = false }
        _ = try? await API.fixUrlMismatch(id: mismatch.id, keep: keep)
        await onChange()
    }
}

private struct UrlCleanupItemView: View {
    let item: UrlQueueItem
    let networks: [String]
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var network: String
    @State private var urlText = ""
    @State private var newTitle: String
    @State private var working = false
    @State private var banner: String?

    init(item: UrlQueueItem, networks: [String], onChange: @escaping () async -> Void) {
        self.item = item
        self.networks = networks
        self.onChange = onChange
        _network = State(initialValue: item.network ?? "")
        _newTitle = State(initialValue: item.title)
    }

    var body: some View {
        Form {
            Section("Show") {
                LabeledContent("Title", value: item.title)
                if let m = item.members, !m.isEmpty { LabeledContent("On", value: m) }
            }

            Section {
                Picker("Network", selection: $network) {
                    Text("None").tag("")
                    ForEach(CANONICAL_NETWORKS, id: \.self) { Text($0).tag($0) }
                }
                // Finding the deep link is the actual work — hand off the
                // search instead of making the operator retype the title.
                if let search = searchURL {
                    Link(destination: search) {
                        Label("Search for “\(item.title)”\(network.isEmpty ? "" : " on \(network)")",
                              systemImage: "magnifyingglass")
                    }
                }
                TextField("Paste the show URL", text: $urlText)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                Button("Save URL") { Task { await saveUrl() } }
                    .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty
                              || network.isEmpty || working)
            } header: {
                Text("Fix the link")
            }

            Section {
                Button("No good link — dismiss", role: .destructive) {
                    Task { await dismissTitle() }
                }
                .disabled(working)
            } footer: {
                Text("Drops this title out of the queue for good. For shows with no real deep link anywhere — the row keeps whatever URL it has.")
            }

            Section {
                TextField("Title", text: $newTitle)
                    .textInputAutocapitalization(.words)
                Button("Rename & re-enrich") { Task { await rename() } }
                    .disabled(newTitle.trimmingCharacters(in: .whitespaces) == item.title
                              || newTitle.trimmingCharacters(in: .whitespaces).isEmpty || working)
            } header: {
                Text("Fix the title")
            } footer: {
                Text("Renames every member's copy and re-pulls the canonical title, rating, and cast.")
            }

            if let b = banner {
                Section { Text(b).foregroundStyle(b.hasPrefix("✓") ? .green : .red) }
            }
        }
        .navigationTitle("Cleanup")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if working { ProgressView().controlSize(.large) } }
    }

    private func saveUrl() async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await API.saveShowUrl(id: item.id, network: network,
                                              url: urlText.trimmingCharacters(in: .whitespaces))
            if let e = r.error { banner = e }
            else {
                banner = "✓ Updated \(r.updated ?? 0) cop\((r.updated ?? 0) == 1 ? "y" : "ies")"
                await finish()
            }
        } catch { banner = "Network error. Try again." }
    }

    private func rename() async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await API.fixShowTitle(id: item.id,
                                               newTitle: newTitle.trimmingCharacters(in: .whitespaces))
            if let e = r.error { banner = e }
            else {
                banner = "✓ Renamed to \(r.newTitle ?? newTitle)"
                await finish()
            }
        } catch { banner = "Network error. Try again." }
    }

    private func dismissTitle() async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await API.dismissUrlTitle(item.title)
            if let e = r.error { banner = e }
            else {
                banner = "✓ Dismissed"
                await finish()
            }
        } catch { banner = "Network error. Try again." }
    }

    // "Severance Apple TV+" on Google — the same helper the web row offers.
    private var searchURL: URL? {
        let terms = [item.title, network.isEmpty ? nil : network]
            .compactMap { $0 }.joined(separator: " ")
        guard let q = terms.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        return URL(string: "https://www.google.com/search?q=\(q)")
    }

    private func finish() async {
        await onChange()
        try? await Task.sleep(nanoseconds: 700_000_000)
        dismiss()
    }
}
