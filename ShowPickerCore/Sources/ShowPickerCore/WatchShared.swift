import Foundation

// A tiny shared store the watch app and its complication both read.
//
// The complication runs in a *separate* process (the widget extension), so it
// can't see the watch app's in-memory session. An App Group gives them a common
// UserDefaults suite: the watch app writes the handed-off member slug (+ cookie)
// here, and the complication's timeline provider reads it to fetch your shows.
//
// Requires the App Group `WatchShared.appGroup` to be enabled on BOTH the watch
// app target and the complication target (Signing & Capabilities → App Groups).
// If it isn't wired up yet, `defaults` falls back to `.standard` so the watch
// app still works — only the complication would come up empty.
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
