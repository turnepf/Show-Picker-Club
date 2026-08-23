import Foundation
#if canImport(Security)
import Security
#endif

// Keychain-backed storage for the session cookie, shared between the main app
// and every target that talks to the API on its own (the Share Extension, the
// widgets, the watch app).
//
// The cookie is a live 30-day credential, so it belongs in the Keychain — not
// in the App Group UserDefaults plist, which is an unencrypted file inside the
// container. The App Group ID doubles as the keychain access group, so every
// target that already carries the group entitlement reads the same item. Where
// the group isn't provisioned we fall back to the target's own keychain: same
// visibility as the old `.standard` defaults fallback, but encrypted.
public enum SessionStore {
    public static let accessGroup = "group.net.patrickturner.showpickerios"
    private static let service = "net.patrickturner.showpickerios.session"
    private static let account = "sessionCookie"

    public static var cookieHeader: String? {
        get { read() }
        set {
            if let newValue, !newValue.isEmpty {
                write(newValue)
            } else {
                delete()
            }
        }
    }

    // MARK: - Keychain plumbing

#if canImport(Security)

    private static func baseQuery(shared: Bool) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            // The modern data-protection keychain everywhere: required for
            // access groups under Mac Catalyst, and already the default on
            // iOS and watchOS.
            kSecUseDataProtectionKeychain as String: true,
        ]
        if shared { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    private static func read() -> String? {
        for shared in [true, false] {
            var q = baseQuery(shared: shared)
            q[kSecReturnData as String] = true
            q[kSecMatchLimit as String] = kSecMatchLimitOne
            var out: AnyObject?
            let status = SecItemCopyMatching(q as CFDictionary, &out)
            if status == errSecSuccess, let data = out as? Data,
               let s = String(data: data, encoding: .utf8), !s.isEmpty {
                return s
            }
            // Only fall through to the un-grouped item when the group itself is
            // unavailable (missing entitlement). A plain "not found" inside the
            // shared group is authoritative — treating it as a miss and reading
            // a stale un-grouped copy would resurrect a logged-out session.
            if shared && status != errSecMissingEntitlement { return nil }
        }
        return nil
    }

    private static func write(_ value: String) {
        // Clear both slots first, so a copy left in the un-grouped fallback by
        // an earlier build can't outlive the value that replaced it.
        delete()
        let data = Data(value.utf8)
        for shared in [true, false] {
            var add = baseQuery(shared: shared)
            add[kSecValueData as String] = data
            // Readable once the device has been unlocked after boot — the
            // widgets and the watch refresh without the user present — and
            // never carried to a new device by a backup.
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let status = SecItemAdd(add as CFDictionary, nil)
            if status != errSecMissingEntitlement { return }
        }
    }

    private static func delete() {
        for shared in [true, false] {
            SecItemDelete(baseQuery(shared: shared) as CFDictionary)
        }
    }
#else
    // Linux only, and only so `swift test` compiles there — the package is
    // Foundation-only by design and CI runs it on ubuntu. No Apple target ever
    // takes this branch, and nothing persists, so a Linux caller reads nil
    // rather than silently getting a plaintext store.
    private static func read() -> String? { nil }
    private static func write(_ value: String) {}
    private static func delete() {}
#endif
}
