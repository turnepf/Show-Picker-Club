import Foundation

// The watch app's persisted session: the member slug (+ cookie) handed off
// from the iPhone, kept so the watch works at cold launch before the phone
// re-sends. Stored in the App Group suite (the watch app target declares the
// `WatchShared.appGroup` entitlement); `defaults` falls back to `.standard`
// if the suite is unavailable, so the cache still works either way.
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

    public static var cookieHeader: String? {
        get { value(cookieKey) }
        set { set(cookieKey, newValue) }
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
