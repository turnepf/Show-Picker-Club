import SwiftUI

// Operator tool: titles still on a placeholder network URL. Tap one to paste a
// real deep link, or fix a wrong/typo'd title. POST /api/admin-url-cleanup.
struct UrlCleanupView: View {
    @State private var items: [UrlQueueItem] = []
    @State private var networks: [String] = []
    @State private var conflicts: [UrlConflict] = []
    @State private var mismatches: [UrlMismatch] = []
    @State private var loading = true

    var body: some View {
        List {
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
        }
        .navigationTitle("URL Cleanup")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        if let r = try? await API.urlCleanupQueue() {
            items = r.shows
            networks = r.networks
            conflicts = r.conflicts ?? []
            mismatches = r.mismatches ?? []
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

            Section("Fix the link") {
                Picker("Network", selection: $network) {
                    Text("None").tag("")
                    ForEach(CANONICAL_NETWORKS, id: \.self) { Text($0).tag($0) }
                }
                TextField("Paste the show URL", text: $urlText)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                Button("Save URL") { Task { await saveUrl() } }
                    .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty
                              || network.isEmpty || working)
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

    private func finish() async {
        await onChange()
        try? await Task.sleep(nanoseconds: 700_000_000)
        dismiss()
    }
}
