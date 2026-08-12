import Foundation

// The watch's on-disk copy of a member's shows.
//
// A cold launch on the watch is slow for reasons the app doesn't control:
// watchOS brings networking up lazily and often proxies through the phone's
// Bluetooth link, so the first request can take seconds or fail outright and
// need a retry. Rather than hold the whole UI behind that, the last good
// response is written here and replayed instantly at launch, then refreshed in
// the background — the list is on screen before the network is even up.
//
// Application Support rather than Caches: watchOS purges Caches under storage
// pressure, which would drop the user back onto the spinner this exists to
// remove. Foundation-only, so `swift test` covers it on Linux CI alongside the
// rest of the package.
public enum WatchCache {

    /// A cache read: the shows plus when they were stored, so the UI can say
    /// how old the list is while a refresh is still in flight.
    public struct Entry: Codable, Sendable {
        public let slug: String
        public let cachedAt: Date
        public let shows: [Show]

        public init(slug: String, cachedAt: Date, shows: [Show]) {
            self.slug = slug
            self.cachedAt = cachedAt
            self.shows = shows
        }
    }

    /// Overridable so tests run against a temporary directory instead of the
    /// real Application Support container.
    public static var baseDirectory: URL = defaultBaseDirectory

    private static var defaultBaseDirectory: URL {
        // `.first` rather than `[0]`: on Linux CI the domain search can come
        // back empty, and a crash in the cache layer would be worse than
        // falling back to a temporary directory.
        let base = FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("WatchCache", isDirectory: true)
    }

    // One file per member. Switching accounts must never flash the previous
    // member's lists, not even for the instant before the refresh lands.
    private static func fileURL(for slug: String) -> URL {
        let safe = slug.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? slug
        return baseDirectory
            .appendingPathComponent("shows-\(safe)")
            .appendingPathExtension("json")
    }

    public static func save(_ shows: [Show], for slug: String, at date: Date = Date()) {
        guard !slug.isEmpty else { return }
        let entry = Entry(slug: slug, cachedAt: date, shows: shows)
        guard let data = try? JSONEncoder().encode(entry) else { return }
        try? FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)
        try? data.write(to: fileURL(for: slug), options: .atomic)
    }

    public static func load(for slug: String) -> Entry? {
        guard !slug.isEmpty,
              let data = try? Data(contentsOf: fileURL(for: slug)),
              let entry = try? JSONDecoder().decode(Entry.self, from: data)
        else { return nil }
        // A file holding someone else's shows is unusable however it got
        // there — treat it as a miss rather than showing the wrong library.
        guard entry.slug == slug else { return nil }
        return entry
    }

    /// Sign-out. Drops every member's copy, not just the one signed in.
    public static func clear() {
        try? FileManager.default.removeItem(at: baseDirectory)
    }
}
