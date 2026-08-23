import Foundation

// The watch app's persisted session: the member slug (+ cookie) handed off
// from the iPhone, kept so the watch works at cold launch before the phone
// re-sends. The slug is not sensitive and lives in the App Group suite (the
// watch app target declares the `WatchShared.appGroup` entitlement);
// `defaults` falls back to `.standard` if the suite is unavailable, so the
// cache still works either way. The cookie does not — see `cookieHeader`.
public enum WatchShared {
    public static let appGroup = "group.net.patrickturner.showpickerios"
    public static let slugKey = "memberSlug"
    public static let cookieKey = "cookieHeader"

    public static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroup) ?? .standard
    }

    public static var memberSlug: String? {
        get { value(slugKey) }
        set { set(slugKey, newValue) }
    }

    // The cookie is a live credential, so it lives in the Keychain
    // (SessionStore), not the plaintext defaults suite. The getter migrates any
    // value an older build wrote to the defaults slot, then scrubs it.
    public static var cookieHeader: String? {
        get {
            if let v = SessionStore.cookieHeader { return v }
            if let legacy = value(cookieKey) {
                SessionStore.cookieHeader = legacy
                set(cookieKey, nil)
                return legacy
            }
            return nil
        }
        set {
            SessionStore.cookieHeader = newValue
            set(cookieKey, nil)
        }
    }

    private static func value(_ key: String) -> String? {
        let v = defaults.string(forKey: key)
        return (v?.isEmpty == false) ? v : nil
    }

    private static func set(_ key: String, _ newValue: String?) {
        if let newValue, !newValue.isEmpty {
            defaults.set(newValue, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}
