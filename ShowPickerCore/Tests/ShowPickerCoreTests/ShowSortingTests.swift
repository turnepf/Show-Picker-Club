import XCTest
@testable import ShowPickerCore

// The rule these pin is the one the three copies kept losing: a show with no
// premiere date sorts *last* on Watching/Awaiting, not first, and rating only
// breaks a tie.
final class ShowSortingTests: XCTestCase {
    private func show(_ id: Int, date: String? = nil, rating: String? = nil) -> Show {
        Show(id: id, title: "S\(id)", rating: rating, list: "watching", nextSeasonDate: date)
    }

    func testUndatedShowsSortAfterDatedOnes() {
        let undated = show(1, rating: "9.9")
        let dated = show(2, date: "2026-12-01", rating: "1.0")
        let out = [undated, dated].sortedForList(.watching)
        XCTAssertEqual(out.map(\.id), [2, 1], "a high rating must not pull an undated show above a dated one")
    }

    func testEmptyDateStringCountsAsUndated() {
        let blank = show(1, date: "", rating: "9.9")
        let dated = show(2, date: "2026-12-01", rating: "1.0")
        XCTAssertEqual([blank, dated].sortedForList(.watching).map(\.id), [2, 1])
    }

    func testSameDateBreaksOnRating() {
        let low = show(1, date: "2026-12-01", rating: "6.0")
        let high = show(2, date: "2026-12-01", rating: "8.0")
        XCTAssertEqual([low, high].sortedForList(.waiting).map(\.id), [2, 1])
    }

    func testLovedAndNextUpOrderByRatingAlone() {
        let soon = show(1, date: "2026-01-01", rating: "5.0")
        let later = show(2, date: "2030-01-01", rating: "9.0")
        XCTAssertEqual([soon, later].sortedForList(.recommending).map(\.id), [2, 1])
        XCTAssertEqual([soon, later].sortedForList(.next).map(\.id), [2, 1])
    }

    func testMissingRatingSortsAsZeroRatherThanCrashing() {
        let unrated = show(1)
        let rated = show(2, rating: "0.1")
        XCTAssertEqual([unrated, rated].sortedForList(.recommending).map(\.id), [2, 1])
    }
}
