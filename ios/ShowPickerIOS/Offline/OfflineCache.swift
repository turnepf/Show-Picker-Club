import Foundation

// Disk-backed JSON cache for read endpoints. Every successful GET writes its
// decoded response here keyed by a stable string (endpoint + params); when a
// later GET fails because the device is offline, we hand back the last good
// copy instead of an error. Lives in Application Support (not Caches) so iOS
// won't purge it out from under an offline user.
enum OfflineCache {
    private static let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("OfflineCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private static func fileURL(for key: String) -> URL {
        // Keep filenames filesystem-safe regardless of the key's punctuation.
        let safe = key.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? key
        return dir.appendingPathComponent(safe).appendingPathExtension("json")
    }

    static func save<T: Encodable>(_ value: T, for key: String) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? data.write(to: fileURL(for: key), options: .atomic)
    }

    static func load<T: Decodable>(_ type: T.Type, for key: String) -> T? {
        guard let data = try? Data(contentsOf: fileURL(for: key)) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static func remove(for key: String) {
        try? FileManager.default.removeItem(at: fileURL(for: key))
    }

    // Wipe everything (used on logout so the next member doesn't see stale data).
    static func clearAll() {
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
}
