import XCTest
import ShowPickerCore

/// The season line on a list row and the date rows on the detail screen
/// (migration 087). Two complaints drove it: "Next episode: 10/7" still
/// showing on 10/8, after the episode had aired, and "4 seasons" on a show
/// whose fifth season was airing. And a request: while a season is on, say
/// when it premiered.
///
/// Every case passes `today` explicitly, so none depends on the test machine's
/// clock.
final class CurrentSeasonTests: XCTestCase {

    private let today = "2026-10-08"

    private func show(next: String? = nil, end: String? = nil, released: Int? = 6,
                      current: Int? = nil, premiere: String? = nil, movie: Int? = 0) -> Show {
        Show(id: 1, title: "Slow Horses", list: "watching", movie: movie,
             nextSeasonDate: next, seasonEndDate: end, seasonsReleased: released,
             currentSeason: current, seasonPremiereDate: premiere)
    }

    // MARK: next-episode dates only while they're ahead

    func testAPassedNextEpisodeIsNotShown() {
        let s = show(next: "2026-10-07")
        XCTAssertNil(s.nextUpRange(today: today))
        XCTAssertNil(s.seasonDatesText(today: today))
    }

    func testAnEpisodeAiringTodayIsStillNext() {
        XCTAssertEqual(show(next: "2026-10-08").nextUpRange(today: today), "10/8")
    }

    func testAPassedFinaleIsNotShownEither() {
        XCTAssertNil(show(end: "2026-10-01").seasonDatesText(today: today))
        XCTAssertEqual(show(end: "2026-10-30").seasonDatesText(today: today), "through 10/30")
    }

    // MARK: the season count never trails the season airing

    func testCountIsAtLeastTheSeasonAiring() {
        let s = show(released: 4, current: 5, premiere: "2026-09-16")
        XCTAssertEqual(s.seasonsText, "5 seasons")
        XCTAssertEqual(s.seriesText, "5 Seasons")
    }

    func testCountIsTMDBsWhenItIsAhead() {
        XCTAssertEqual(show(released: 6, current: 5).seasonsText, "6 seasons")
    }

    func testAMovieHasNoSeasonCount() {
        XCTAssertNil(show(released: nil, current: 2, movie: 1).seasonsText)
    }

    // MARK: the row line

    func testASeasonOnAirSaysWhenItPremieredAndWhatIsNext() {
        let s = show(next: "2026-10-14", current: 6, premiere: "2026-09-16")
        XCTAssertEqual(s.listLine(today: today), "Season 6 · premiered 9/16 · next 10/14")
        XCTAssertEqual(s.currentSeasonText(today: today), "Season 6 · premiered 9/16")
    }

    /// The case from the screenshots: the stored next episode aired yesterday
    /// and the refresh hasn't been round yet. The season is still on, so say
    /// so, without the stale date.
    func testAStaleNextEpisodeStillShowsTheSeason() {
        let s = show(next: "2026-10-07", current: 6, premiere: "2026-09-16")
        XCTAssertEqual(s.listLine(today: today), "Season 6 · premiered 9/16")
    }

    func testASeasonAboutToStartSaysWhen() {
        let s = show(next: "2026-10-14", current: 7, premiere: "2026-10-14")
        XCTAssertEqual(s.listLine(today: today), "Season 7 premieres 10/14")
    }

    /// A Loved copy carries no next-episode date, but a new season with a
    /// premiere date ahead is exactly what's worth surfacing on it.
    func testAPremiereAheadShowsWithoutANextDate() {
        XCTAssertEqual(show(current: 7, premiere: "2026-11-01").listLine(today: today),
                       "Season 7 premieres 11/1")
    }

    /// A finished season with nothing scheduled: no premiere line, just the
    /// count, as before.
    func testAFinishedSeasonFallsBackToTheCount() {
        XCTAssertEqual(show(released: 4, current: 4, premiere: "2026-08-04").listLine(today: today), "4 seasons")
    }

    /// Rows a refresh hasn't reached since migration 087 read as they did.
    func testWithoutSeasonDataTheRowReadsAsBefore() {
        XCTAssertEqual(show(next: "2026-10-14").listLine(today: today), "Next episode: 10/14 · 6 seasons")
        XCTAssertEqual(show().listLine(today: today), "6 seasons")
        XCTAssertEqual(show(next: "2026-10-07").listLine(today: today), "6 seasons")
    }

    func testTheDetailRowSplitsLabelAndDate() {
        let on = show(next: "2026-10-14", current: 6, premiere: "2026-09-16")
        XCTAssertEqual(on.currentSeasonText(today: today), "Season 6 · premiered 9/16")
        let soon = show(current: 7, premiere: "2027-01-09")
        XCTAssertEqual(soon.currentSeasonText(today: today), "Season 7 premieres 1/9")
        XCTAssertNil(show(released: 4, current: 4, premiere: "2026-08-04").currentSeasonText(today: today))
    }

    func testDecodesTheNewFields() throws {
        let json = #"{"id":1,"title":"Slow Horses","current_season":6,"season_premiere_date":"2026-09-16"}"#
        let s = try JSONDecoder().decode(Show.self, from: Data(json.utf8))
        XCTAssertEqual(s.currentSeason, 6)
        XCTAssertEqual(s.seasonPremiereDate, "2026-09-16")
    }

    func testTodayIsADayStamp() {
        XCTAssertTrue(Show.todayString().range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil)
    }
}
