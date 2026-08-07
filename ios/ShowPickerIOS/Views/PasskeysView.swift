import SwiftUI
import UIKit

// Manage the passkeys on this account: add one for this device, see the ones
// already registered, remove any that shouldn't be there.
//
// Reached from the account menu on iPhone and the iPad sidebar. Adding
// requires a session, which is the point — a passkey is added by someone who
// has already proved the account is theirs, and only then becomes a way back
// in. Removing them all is allowed: the original sign-in method (Apple,
// Google, or an email code) never goes away, so this can't lock anyone out.
struct PasskeysView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthStore

    @State private var passkeys: [Passkey] = []
    @State private var loading = true
    @State private var loadFailed = false
    @State private var adding = false
    @State private var errorText: String?
    @State private var justAdded = false
    @State private var pendingDelete: Passkey?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        Task { await addPasskey() }
                    } label: {
                        if adding {
                            ProgressView()
                        } else {
                            Label("Add a passkey for this \(Self.deviceKind)", systemImage: "plus.circle")
                        }
                    }
                    .disabled(adding)
                } footer: {
                    Text("A passkey signs you in with Face ID or Touch ID — no code to wait for. It's stored in your iCloud Keychain, so adding one here covers your iPhone, iPad and Mac.")
                }

                if let errorText {
                    Section { Text(errorText).foregroundStyle(.red).font(.callout) }
                }

                Section("Your passkeys") {
                    if loading {
                        HStack { ProgressView(); Text("Loading…").foregroundStyle(.secondary) }
                    } else if passkeys.isEmpty {
                        // Say which state this is: a failed fetch and a genuinely
                        // empty list look identical when the row just says "none".
                        Text(loadFailed
                             ? "Couldn't load your passkeys — pull down to try again."
                             : "No passkeys yet. Add one above and you can skip the sign-in code next time.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(passkeys) { passkey in
                        row(passkey)
                    }
                }
            }
            .navigationTitle("Passkeys")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .refreshable { await load() }
            .task { if loading { await load() } }
            .alert("Passkey added", isPresented: $justAdded) {
                Button("OK", role: .cancel) { }
            } message: {
                Text("Next time you sign in, tap \"Sign in with a passkey\".")
            }
            // A .constant binding here would leave the dialog stuck: dismissing
            // it by tapping outside sets the binding false, and a constant
            // swallows that while pendingDelete stays non-nil.
            .confirmationDialog("Remove this passkey?",
                                isPresented: Binding(get: { pendingDelete != nil },
                                                     set: { if !$0 { pendingDelete = nil } }),
                                titleVisibility: .visible,
                                presenting: pendingDelete) { passkey in
                Button("Remove", role: .destructive) {
                    Task { await remove(passkey) }
                }
                Button("Cancel", role: .cancel) { pendingDelete = nil }
            } message: { _ in
                Text("That device won't be able to sign in with a passkey any more. You can still sign in the way you did originally.")
            }
        }
    }

    private func row(_ passkey: Passkey) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(passkey.label ?? "Passkey")
            Text(subtitle(for: passkey))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .swipeActions {
            Button(role: .destructive) { pendingDelete = passkey } label: {
                Label("Remove", systemImage: "trash")
            }
        }
    }

    private func subtitle(for passkey: Passkey) -> String {
        if let used = Self.shortDate(passkey.lastUsedAt) { return "Last used \(used)" }
        if let added = Self.shortDate(passkey.createdAt) { return "Added \(added) · never used" }
        return "Never used"
    }

    // MARK: Actions

    private func load() async {
        loadFailed = false
        do {
            passkeys = try await API.passkeys()
        } catch {
            loadFailed = true
        }
        loading = false
    }

    private func addPasskey() async {
        errorText = nil
        adding = true
        defer { adding = false }
        do {
            // Since iOS 16 this is the generic model name ("iPhone") unless
            // the app holds the device-name entitlement, which is fine — the
            // label exists to tell two passkeys apart, not to be exact.
            try await auth.registerPasskey(label: UIDevice.current.name)
            justAdded = true
            await load()
        } catch PasskeyAuthenticator.Failure.canceled {
            // Backed out of the system sheet — nothing to report.
        } catch let e as API.APIError where e.status == 409 {
            // too_many_passkeys, or the credential already belongs elsewhere.
            errorText = "Couldn't add another passkey. Remove one you no longer use and try again."
        } catch let e as API.APIError where e.status == 401 {
            errorText = "You're logged out — sign in again from Home."
        } catch {
            errorText = API.failureLine(error, action: "add the passkey")
        }
    }

    private func remove(_ passkey: Passkey) async {
        pendingDelete = nil
        errorText = nil
        // Optimistic: the row disappears now, and comes back if the delete
        // didn't take.
        let previous = passkeys
        passkeys.removeAll { $0.id == passkey.id }
        do {
            try await API.deletePasskey(credentialID: passkey.credentialId)
        } catch {
            passkeys = previous
            errorText = API.failureLine(error, action: "remove the passkey")
        }
    }

    // MARK: Formatting

    private static var deviceKind: String {
        if ProcessInfo.processInfo.isMacCatalystApp { return "Mac" }
        return UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
    }

    private static let inputFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static func shortDate(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        // The server writes ISO-8601 with fractional seconds from
        // toISOString(), and SQLite's datetime('now') without them.
        let date = inputFormatter.date(from: raw)
            ?? ISO8601DateFormatter().date(from: raw)
            ?? ISO8601DateFormatter().date(from: raw.replacingOccurrences(of: " ", with: "T") + "Z")
        guard let date else { return nil }
        return date.formatted(.dateTime.month(.abbreviated).day().year())
    }
}
