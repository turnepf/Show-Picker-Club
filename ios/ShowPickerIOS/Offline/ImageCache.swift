import Foundation
import UIKit
import CryptoKit

// Disk-backed store for artwork (posters, backdrops), keyed by URL. AsyncImage
// leans on URLCache, which iOS evicts freely — so a device that went offline
// often had the show data cached but not the art. Every image the app renders
// or prefetches lands here instead; a URL that's on disk loads offline forever
// after. Same Application Support home as OfflineCache, and for the same
// reason: Caches can be purged out from under an offline user.
final class ImageCache: @unchecked Sendable {
    static let shared = ImageCache()

    // Decoded images for the session, so scrolling a list doesn't re-read and
    // re-decode the same posters from disk.
    private let memory = NSCache<NSString, UIImage>()

    private let dir: URL = {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let d = base.appendingPathComponent("ImageCache", isDirectory: true)
        try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }()

    private init() {
        memory.countLimit = 300
    }

    // Artwork URLs are long enough to flirt with filename limits, so the file
    // name is a digest of the URL rather than the URL itself.
    private func fileURL(for urlString: String) -> URL {
        let digest = SHA256.hash(data: Data(urlString.utf8))
        let name = digest.map { String(format: "%02x", $0) }.joined()
        return dir.appendingPathComponent(name)
    }

    // Fast path for views: whatever's already decoded this session.
    func cachedImage(for urlString: String) -> UIImage? {
        memory.object(forKey: urlString as NSString)
    }

    // Disk, then network. Successful downloads are written through to disk so
    // the next launch — online or not — starts warm.
    func image(for urlString: String) async -> UIImage? {
        if let hit = cachedImage(for: urlString) { return hit }
        let file = fileURL(for: urlString)
        if let data = try? Data(contentsOf: file), let img = UIImage(data: data) {
            memory.setObject(img, forKey: urlString as NSString)
            return img
        }
        guard let data = await download(urlString), let img = UIImage(data: data) else { return nil }
        memory.setObject(img, forKey: urlString as NSString)
        return img
    }

    // Ensure a URL is on disk without decoding it into memory — what the
    // offline prefetcher calls for every show on every list.
    func prefetch(_ urlString: String) async {
        let file = fileURL(for: urlString)
        if FileManager.default.fileExists(atPath: file.path) { return }
        _ = await download(urlString)
    }

    private func download(_ urlString: String) async -> Data? {
        guard let url = URL(string: urlString) else { return nil }
        var req = URLRequest(url: url)
        req.cachePolicy = .returnCacheDataElseLoad
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              !data.isEmpty
        else { return nil }
        // Artwork is public catalog imagery, not member data — no file
        // protection needed beyond the device's default.
        try? data.write(to: fileURL(for: urlString), options: [.atomic])
        return data
    }

    // Logout wipe, alongside OfflineCache.clearAll().
    func clearAll() {
        memory.removeAllObjects()
        try? FileManager.default.removeItem(at: dir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }
}
