import SwiftUI

// Changelog, rendered from the shared /whats-new.json — the same single
// source of truth the web page uses, so the platforms can't drift. The last
// successful fetch is cached in UserDefaults for offline viewing. Reachable
// from under My Shows on the iPhone home screen and from the iPad sidebar.
struct WhatsNewView: View {
    private struct Entry: Decodable, Identifiable {
        let date: String?
        let title: String
        let body: String
        var id: String { (date ?? "") + title }
    }
    private struct Feed: Decodable {
        let coming_soon: [Entry]?
        let entries: [Entry]?
    }

    private static let cacheKey = "whats_new_cache"

    @State private var comingSoon: [Entry] = []
    @State private var entries: [Entry] = []
    @State private var failed = false

    // e.g. "Version 1.0.2 (15)" — read from the bundle so it always matches
    // the running binary; this is what to ask a member for when debugging.
    private var versionLine: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Version \(version) (\(build))"
    }

    var body: some View {
        List {
            if failed && entries.isEmpty {
                Section {
                    Text("Couldn't load What's New. Check your connection and come back.")
                        .foregroundStyle(.secondary)
                }
            }

            if !comingSoon.isEmpty {
                Section {
                    ForEach(comingSoon) { e in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(e.title).fontWeight(.semibold).foregroundColor(.primary)
                                .font(.subheadline)
                            Text(e.body)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                } header: {
                    Text("Coming soon")
                }
            }

            if !entries.isEmpty {
                Section {
                    ForEach(entries) { e in
                        VStack(alignment: .leading, spacing: 4) {
                            (Text(e.date ?? "").fontWeight(.semibold).foregroundColor(.primary)
                             + Text("  ")
                             + Text(e.title).fontWeight(.semibold).foregroundColor(.primary))
                                .font(.subheadline)
                            Text(e.body)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }

            Section {
            } footer: {
                Text(versionLine)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
                    .padding(.top, 4)
            }
        }
        .listStyle(.plain)
        .navigationTitle("What's New")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func apply(_ data: Data) -> Bool {
        guard let feed = try? JSONDecoder().decode(Feed.self, from: data) else { return false }
        comingSoon = feed.coming_soon ?? []
        entries = feed.entries ?? []
        return true
    }

    private func load() async {
        // Cached copy first so the screen is never blank offline.
        if let cached = UserDefaults.standard.data(forKey: Self.cacheKey) {
            _ = apply(cached)
        }
        guard let url = URL(string: API.baseString + "/whats-new.json") else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            if apply(data) {
                UserDefaults.standard.set(data, forKey: Self.cacheKey)
                failed = false
            }
        } catch {
            failed = entries.isEmpty
        }
    }
}
