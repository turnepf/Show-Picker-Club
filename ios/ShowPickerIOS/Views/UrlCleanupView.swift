import SwiftUI

// Operator tool: titles still on a placeholder network URL, and links whose
// domain disagrees with the stored service. Tap one to paste a real deep
// link. POST /api/admin-url-cleanup. (Renaming, re-enriching and network
// conflicts left in 2026-10: TMDB names every show and the nightly passes
// fill details by TMDB id; the admin AI tools handle one-off fixes.)
struct UrlCleanupView: View {
    @State private var items: [UrlQueueItem] = []
    @State private var networks: [String] = []
    @State private var mismatches: [UrlMismatch] = []
    @State private var loading = true

    var body: some View {
        List {
            // What's left to do, before any of the queues — the same summary
            // line the web puts at the top.
            Section {
                Text(remainingLine)
                    .font(.callout)
                    .foregroundStyle(.secondary)
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
        .navigationTitle("Show Cleanup")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    private var remainingLine: String {
        let parts = [
            "\(items.count) show\(items.count == 1 ? "" : "s") remaining",
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
            mismatches = r.mismatches ?? []
        }
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
        await ErrorCenter.run("apply the fix", { _ = try await API.fixUrlMismatch(id: mismatch.id, keep: keep) })
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
    @State private var working = false
    @State private var banner: String?

    init(item: UrlQueueItem, networks: [String], onChange: @escaping () async -> Void) {
        self.item = item
        self.networks = networks
        self.onChange = onChange
        _network = State(initialValue: item.network ?? "")
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
                    ForEach(NetworkCatalogStore.shared.names, id: \.self) { Text($0).tag($0) }
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
