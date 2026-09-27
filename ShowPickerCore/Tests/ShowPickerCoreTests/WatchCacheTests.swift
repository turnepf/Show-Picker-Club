import XCTest
import ShowPickerCore

/// Covers the watch's stale-while-revalidate cache: a cold launch has to paint
/// the last known lists instead of a spinner, and it must never paint the
/// wrong member's lists to do it.
///
/// Runs on Linux CI via `swift test` — `WatchCache` is deliberately
/// Foundation-only for exactly this reason.
final class WatchCacheTests: XCTestCase {

    private var tempDir: URL!

    override func setUp() {
        super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("WatchCacheTests-\(UUID().uuidString)", isDirectory: true)
        WatchCache.baseDirectory = tempDir
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempDir)
        super.tearDown()
    }

    private func show(_ id: Int, _ title: String, list: String = "watching") -> Show {
        Show(id: id, title: title, list: list)
    }

    func testRoundTrip() {
        WatchCache.save([show(1, "Severance"), show(2, "The Bear")], for: "patrick")

        let entry = WatchCache.load(for: "patrick")
        XCTAssertEqual(entry?.shows.count, 2)
        XCTAssertEqual(entry?.shows.first?.title, "Severance")
        XCTAssertEqual(entry?.slug, "patrick")
    }

    func testMissReturnsNil() {
        XCTAssertNil(WatchCache.load(for: "nobody"))
    }

    /// The point of the whole file: a launch with no network still has lists.
    func testCachedShowsSurviveWithoutRefresh() {
        WatchCache.save([show(1, "Andor")], for: "patrick")
        // Simulates a fresh process — nothing in memory, only what's on disk.
        XCTAssertEqual(WatchCache.load(for: "patrick")?.shows.first?.title, "Andor")
    }

    /// Two members on one watch must not bleed into each other.
    func testCacheIsScopedPerMember() {
        WatchCache.save([show(1, "Severance")], for: "patrick")
        WatchCache.save([show(2, "Ted Lasso")], for: "quinn")

        XCTAssertEqual(WatchCache.load(for: "patrick")?.shows.first?.title, "Severance")
        XCTAssertEqual(WatchCache.load(for: "quinn")?.shows.first?.title, "Ted Lasso")
    }

    func testSaveOverwritesPreviousEntry() {
        WatchCache.save([show(1, "Severance"), show(2, "The Bear")], for: "patrick")
        WatchCache.save([show(3, "Shrinking")], for: "patrick")

        let entry = WatchCache.load(for: "patrick")
        XCTAssertEqual(entry?.shows.count, 1)
        XCTAssertEqual(entry?.shows.first?.title, "Shrinking")
    }

    /// An empty list is a real answer ("you removed everything"), not a miss —
    /// otherwise the watch would keep replaying a library the member cleared.
    func testEmptyShowsIsCachedRatherThanTreatedAsMiss() {
        WatchCache.save([], for: "patrick")

        let entry = WatchCache.load(for: "patrick")
        XCTAssertNotNil(entry)
        XCTAssertEqual(entry?.shows.count, 0)
    }

    func testCachedAtIsPreserved() {
        let stamp = Date(timeIntervalSince1970: 1_700_000_000)
        WatchCache.save([show(1, "Andor")], for: "patrick", at: stamp)

        let loaded = WatchCache.load(for: "patrick")?.cachedAt
        XCTAssertEqual(loaded?.timeIntervalSince1970 ?? 0, stamp.timeIntervalSince1970, accuracy: 1)
    }

    /// Sign-out has to leave nothing behind for the next member.
    func testClearRemovesEveryMember() {
        WatchCache.save([show(1, "Severance")], for: "patrick")
        WatchCache.save([show(2, "Ted Lasso")], for: "quinn")

        WatchCache.clear()

        XCTAssertNil(WatchCache.load(for: "patrick"))
        XCTAssertNil(WatchCache.load(for: "quinn"))
    }

    /// Saving after a clear has to recreate the directory, not silently no-op.
    func testSaveWorksAfterClear() {
        WatchCache.save([show(1, "Severance")], for: "patrick")
        WatchCache.clear()
        WatchCache.save([show(2, "Ted Lasso")], for: "patrick")

        XCTAssertEqual(WatchCache.load(for: "patrick")?.shows.first?.title, "Ted Lasso")
    }

    func testEmptySlugIsIgnoredRatherThanWritingAStrayFile() {
        WatchCache.save([show(1, "Severance")], for: "")
        XCTAssertNil(WatchCache.load(for: ""))
    }

    /// Slugs go into the filename, so punctuation must not escape the directory.
    func testSlugWithPunctuationIsStoredSafely() {
        WatchCache.save([show(1, "Severance")], for: "../etc/passwd")

        XCTAssertEqual(WatchCache.load(for: "../etc/passwd")?.shows.first?.title, "Severance")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: tempDir.path)) ?? []
        XCTAssertEqual(files.count, 1)
    }

    /// `sortOrder` drives the watch's "My Order" sort, so it has to survive the
    /// encode/decode round trip rather than resetting to nil on a cold launch.
    func testSortOrderSurvivesRoundTrip() {
        var s = show(1, "Severance")
        s.sortOrder = 3
        WatchCache.save([s], for: "patrick")

        XCTAssertEqual(WatchCache.load(for: "patrick")?.shows.first?.sortOrder, 3)
    }
}
