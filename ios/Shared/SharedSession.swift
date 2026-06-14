import Foundation

// Shared utilities for persisting the session cookie between the main app
// and the Share Extension (separate processes). Uses an App Group container.
// ADD THIS FILE TO BOTH TARGETS: ShowPickerIOS + ShowPickerShareExtension.
enum SharedSession {
    static let appGroupID = "group.net.patrickturner.showpickerios"

    private static let cookieKey = "sessionCookieHeader"
    private static let slugKey   = "memberSlug"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: appGroupID)
    }

    // Call from the main app after a successful login or auth check.
    static func sync(memberSlug: String) {
        guard let url = URL(string: "https://showpicker.club"),
              let cookies = HTTPCookieStorage.shared.cookies(for: url),
              !cookies.isEmpty else { return }
        let header = HTTPCookie.requestHeaderFields(with: cookies)["Cookie"]
        defaults?.set(header,      forKey: cookieKey)
        defaults?.set(memberSlug,  forKey: slugKey)
    }

    // Call from the main app on logout.
    static func clear() {
        defaults?.removeObject(forKey: cookieKey)
        defaults?.removeObject(forKey: slugKey)
    }

    // Used by the Share Extension to attach a Cookie header to requests.
    static var cookieHeader: String? {
        guard let v = defaults?.string(forKey: cookieKey), !v.isEmpty else { return nil }
        return v
    }

    // Used by the Share Extension to know which member is logged in.
    static var memberSlug: String? {
        defaults?.string(forKey: slugKey)
    }
}
