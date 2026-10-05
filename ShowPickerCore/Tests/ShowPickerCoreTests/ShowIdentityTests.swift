import XCTest
@testable import ShowPickerCore

final class ShowIdentityTests: XCTestCase {
    private func same(_ a: (String, Bool, Int?), _ b: (String, Bool, Int?)) -> Bool {
        ShowIdentity.same(title: a.0, isMovie: a.1, tmdbId: a.2, title: b.0, isMovie: b.1, tmdbId: b.2)
    }

    func testTwoEntriesSharingATitleAreDifferentShows() {
        XCTAssertFalse(same(("The Odyssey", true, 1368337), ("The Odyssey", true, 1698863)))
    }

    func testTheSameEntryIsTheSameShowWhateverItsTitleSays() {
        XCTAssertTrue(same(("Odyssey", true, 1368337), ("The Odyssey", true, 1368337)))
    }

    func testAnUnmatchedSideFallsBackToTheTitle() {
        XCTAssertTrue(same(("the odyssey", true, nil), ("The Odyssey", true, 1698863)))
        XCTAssertTrue(same(("The Odyssey", true, 1698863), ("THE ODYSSEY", true, nil)))
        XCTAssertFalse(same(("The Odyssey", true, nil), ("Odyssey", true, nil)))
    }

    func testASeriesAndAFilmAreNeverTheSameShow() {
        XCTAssertFalse(same(("Fargo", false, nil), ("Fargo", true, nil)))
        XCTAssertFalse(same(("Fargo", false, 60622), ("Fargo", true, 60622)))
    }
}
