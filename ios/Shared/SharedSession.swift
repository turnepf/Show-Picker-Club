import Foundation
import ShowPickerCore

// Shared utilities for persisting the session between the main app and the
// Share Extension (separate processes). The member slug isn't sensitive and
// lives in the App Group UserDefaults; the session cookie is a live credential
// and lives in the Keychain via ShowPickerCore.SessionStore, shared through the
// same App Group ID acting as the keychain access group.
// ADD THIS FILE TO BOTH TARGETS: ShowPickerIOS + ShowPickerShareExtension.
enum SharedSession {
    static let appGroupID = "group.net.patrickturner.showpickerios"

    // The plaintext cookie slot older builds wrote to — read once to migrate
    // the value into the Keychain, then scrubbed.
    private static let legacyCookieKey = "sessionCookieHeader"
    private static let slugKey = "memberSlug"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupID)
    }

    // Call from the main app after a successful login or auth check.
    static func sync(memberSlug: String) {
        guard let url = URL(string: "https://showpicker.club"),
              let cookies = HTTPCookieStorage.shared.cookies(for: url),
              !cookies.isEmpty else { return }
        let header = HTTPCookie.requestHeaderFields(with: cookies)["Cookie"]
        SessionStore.cookieHeader = header
        defaults?.removeObject(forKey: legacyCookieKey)
        defaults?.set(memberSlug, forKey: slugKey)
    }

    // Call from the main app on logout.
    static func clear() {
        SessionStore.cookieHeader = nil
        defaults?.removeObject(forKey: legacyCookieKey)
        defaults?.removeObject(forKey: slugKey)
    }

    // Used by the Share Extension to attach a Cookie header to requests.
    static var cookieHeader: String? {
        if let v = SessionStore.cookieHeader { return v }
        // Migrate a cookie an older build left in the plaintext defaults slot,
        // so upgrading doesn't sign the extension out.
        if let legacy = defaults?.string(forKey: legacyCookieKey), !legacy.isEmpty {
            SessionStore.cookieHeader = legacy
            defaults?.removeObject(forKey: legacyCookieKey)
            return legacy
        }
        return nil
    }

    // Used by the Share Extension to know which member is logged in.
    static var memberSlug: String? {
        defaults?.string(forKey: slugKey)
    }
}
