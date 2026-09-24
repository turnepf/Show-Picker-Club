import SwiftUI

// The AI apps (Claude, ChatGPT, Claude Code) connected to this account through
// the MCP server at showpicker.club/mcp, and the way to cut one off.
//
// Reached from the account menu on iPhone and the iPad/Mac sidebar, next to
// Passkeys. Connecting happens in the AI app and a browser — OAuth is a web
// flow — so this screen links out to showpicker.club/connect rather than
// doing it here. Disconnecting takes effect on the app's next request: the
// server revokes the whole grant, access and refresh tokens alike
// (docs/INVARIANTS.md §27).
struct ConnectedAppsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var apps: [ConnectedApp] = []
    @State private var loading = true
    @State private var loadFailed = false
    @State private var errorText: String?
    @State private var pendingDisconnect: ConnectedApp?

    private static let connectURL = URL(string: API.baseString + "/connect")!

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        openURL(Self.connectURL)
                    } label: {
                        Label("Connect an AI app", systemImage: "plus.circle")
                    }
                } footer: {
                    Text("Use Show Picker Club from Claude or ChatGPT: ask what's on your Next Up, add shows, move them when you finish. Connected apps get the same access you have here, and you choose whether they can make changes.")
                }

                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red).font(.callout) }
                }

                Section("Connected") {
                    if loading {
                        HStack { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
                    } else if apps.isEmpty {
                        // A failed fetch and a genuinely empty list must not
                        // read the same.
                        Text(loadFailed
                             ? "Couldn't load your connected apps — pull down to try again."
                             : "No apps connected.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(apps) { app in
                        row(app)
                    }
                }
            }
            .navigationTitle("Connected Apps")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .refreshable { await load() }
            .task { if loading { await load() } }
            // Same binding shape as PasskeysView: a .constant would leave the
            // dialog stuck after a tap outside.
            .confirmationDialog("Disconnect this app?",
                                isPresented: Binding(get: { pendingDisconnect != nil },
                                                     set: { if !$0 { pendingDisconnect = nil } }),
                                titleVisibility: .visible,
                                presenting: pendingDisconnect) { app in
                Button("Disconnect", role: .destructive) {
                    Task { await disconnect(app) }
                }
                Button("Cancel", role: .cancel) { pendingDisconnect = nil }
            } message: { app in
                Text("\(app.name) will stop working with Show Picker Club right away. You can connect it again later.")
            }
        }
    }

    private func row(_ app: ConnectedApp) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(app.name)
            Text(detail(for: app))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(usage(for: app))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .swipeActions {
            Button(role: .destructive) { pendingDisconnect = app } label: {
                Label("Disconnect", systemImage: "xmark.circle")
            }
        }
        // Swipe isn't discoverable with a pointer on Mac, and VoiceOver users
        // get the action by name either way.
        .contextMenu {
            Button(role: .destructive) { pendingDisconnect = app } label: {
                Label("Disconnect", systemImage: "xmark.circle")
            }
        }
    }

    private func detail(for app: ConnectedApp) -> String {
        let access = app.canWrite ? "Can read and make changes" : "Read-only"
        guard let host = app.host, !host.isEmpty else { return access }
        return "via \(host) · \(access)"
    }

    private func usage(for app: ConnectedApp) -> String {
        let used = Self.shortDate(app.lastUsedAt).map { "Last used \($0)" } ?? "Never used"
        guard let connected = Self.shortDate(app.connectedAt) else { return used }
        return "Connected \(connected) · \(used)"
    }

    // MARK: Actions

    private func load() async {
        loadFailed = false
        do {
            apps = try await API.connectedApps()
            errorText = nil
        } catch let e as API.APIError where e.status == 401 {
            errorText = "You're logged out — sign in again from Home."
            loadFailed = true
        } catch {
            loadFailed = true
        }
        loading = false
    }

    private func disconnect(_ app: ConnectedApp) async {
        pendingDisconnect = nil
        errorText = nil
        // Optimistic: the row goes now and comes back if the revoke didn't
        // take. A 404 means it was already gone (disconnected from the web
        // page or the AI app), which is the outcome the member asked for.
        let previous = apps
        apps.removeAll { $0.id == app.id }
        do {
            try await API.disconnectApp(id: app.id)
        } catch let e as API.APIError where e.status == 404 {
            await load()
        } catch {
            apps = previous
            errorText = API.failureLine(error, action: "disconnect \(app.name)")
        }
    }

    // MARK: Formatting

    // The server writes these with SQLite's datetime('now'): UTC, a space
    // instead of the T, no zone designator.
    private static func shortDate(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        let iso = raw.contains("T") ? raw : raw.replacingOccurrences(of: " ", with: "T") + "Z"
        guard let date = ISO8601DateFormatter().date(from: iso) else { return nil }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}
