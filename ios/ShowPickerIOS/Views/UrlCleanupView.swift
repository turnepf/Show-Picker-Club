import SwiftUI

// Operator tool: titles still on a placeholder network URL. Tap one to paste a
// real deep link, or fix a wrong/typo'd title. POST /api/admin-url-cleanup.
struct UrlCleanupView: View {
    @State private var items: [UrlQueueItem] = []
    @State private var networks: [String] = []
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
            } footer: {
                Text("Titles whose only link is a search-page placeholder.")
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
        }
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
