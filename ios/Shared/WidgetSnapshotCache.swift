import Foundation

// Last-good snapshots for the home-screen widgets, stored in the App Group
// container so both processes reach the same files: the widget extension
// writes a snapshot after every successful fetch and reads it back when a
// later fetch fails (airplane mode, dead spots), and the main app clears them
// on logout so the next member on the device doesn't inherit stale rows.
// ADD THIS FILE TO BOTH TARGETS: ShowPickerIOS + ShowPickerWidgetsExtension.
enum WidgetSnapshotCache {
    private static var dir: URL? {
        FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: SharedSession.appGroupID)?
            .appendingPathComponent("Library/Caches/WidgetSnapshots", isDirectory: true)
    }

    private static func fileURL(for key: String) -> URL? {
        guard let dir else { return nil }
        let safe = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key
        return dir.appendingPathComponent(safe).appendingPathExtension("json")
    }

    static func save<T: Encodable>(_ value: T, for key: String) {
        guard let url = fileURL(for: key), let dir,
              let data = try? JSONEncoder().encode(value) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Until-first-unlock rather than complete protection: WidgetKit can
        // refresh timelines while the device is locked, and a widget that
        // can't read its own snapshot at that moment would render empty.
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func load<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        guard let url = fileURL(for: key), let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    // Called by the main app on logout, alongside the other cache wipes.
    static func clearAll() {
        guard let dir else { return }
        try? FileManager.default.removeItem(at: dir)
    }
}
