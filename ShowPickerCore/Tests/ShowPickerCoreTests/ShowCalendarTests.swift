import XCTest
import ShowPickerCore

/// The rule the Up Next widget and the in-app Calendar screen share: "next" is
/// the next *dated* thing on your Watching/Awaiting lists — a season premiere
/// or a season finale — not a premiere alone. The widget went blank for weeks
/// at a time when it only read `next_season_date`.
final class ShowCalendarTests: XCTestCase {

    private let cal = Calendar.current

    /// A fixed reference day so "today" never moves under the tests.
    private var today: Date {
        cal.startOfDay(for: ShowCalendar.day("2026-08-10")!)
    }

    private func show(_ id: Int,
                      _ title: String,
                      list: ShowList = .watching,
                      premiere: String? = nil,
                      finale: String? = nil,
                      seasonPremiere: String? = nil,
                      archived: Int? = nil) -> Show {
        Show(id: id, title: title, list: list.rawValue,
             nextSeasonDate: premiere, seasonEndDate: finale, archived: archived,
             seasonPremiereDate: seasonPremiere)
    }

    // MARK: What counts as a calendar date

    func testFinaleOnlyShowIsOnTheCalendar() {
        let shows = [show(1, "Slow Horses", finale: "2026-08-20")]
        let next = ShowCalendar.next(from: shows, on: today, calendar: cal)
        XCTAssertEqual(next?.show.id, 1)
        XCTAssertEqual(next?.kind, .finale)
        XCTAssertEqual(next?.label, "Finale")
    }

    func testSoonerFinaleBeatsLaterPremiere() {
        let shows = [
            show(1, "Severance", premiere: "2026-12-01"),
            show(2, "The Bear", finale: "2026-08-14"),
        ]
        XCTAssertEqual(ShowCalendar.next(from: shows, on: today, calendar: cal)?.show.id, 2)
    }

    func testShowWithBothDatesAppearsOnceOnTheSoonerOne() {
        let shows = [show(1, "The Pitt", premiere: "2026-09-01", finale: "2026-08-15")]
        let items = ShowCalendar.upcoming(from: shows, on: today, calendar: cal)
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.first?.kind, .finale)
        XCTAssertEqual(items.first?.day, "2026-08-15")
    }

    func testDateTodayStillCounts() {
        let shows = [show(1, "Andor", premiere: "2026-08-10", seasonPremiere: "2026-08-10")]
        let next = ShowCalendar.next(from: shows, on: today, calendar: cal)
        XCTAssertEqual(next?.show.id, 1)
        XCTAssertEqual(next?.kind, .premiere)
    }

    // MARK: Premiere or just the next episode

    /// `next_season_date` is TMDB's next episode. Mid-season it is not a
    /// premiere — Slow Horses premiered 9/16 and its 10/14 episode read
    /// "Premieres Wed, Oct 14" on the Calendar screen.
    func testMidSeasonEpisodeIsNotAPremiere() {
        let shows = [show(1, "Slow Horses", premiere: "2026-08-14", seasonPremiere: "2026-07-17")]
        let next = ShowCalendar.next(from: shows, on: today, calendar: cal)
        XCTAssertEqual(next?.kind, .episode)
        XCTAssertEqual(next?.label, "New episode")
    }

    /// With no season premiere known, nothing says the date opens a season,
    /// so it isn't claimed as one.
    func testUnknownSeasonPremiereIsNotClaimedAsAPremiere() {
        let shows = [show(1, "MobLand", premiere: "2026-08-14")]
        XCTAssertEqual(ShowCalendar.next(from: shows, on: today, calendar: cal)?.kind, .episode)
    }

    func testFirstEpisodeOfASeasonIsAPremiere() {
        let shows = [show(1, "Severance", list: .waiting, premiere: "2026-09-01", seasonPremiere: "2026-09-01")]
        XCTAssertEqual(ShowCalendar.next(from: shows, on: today, calendar: cal)?.label, "Premieres")
    }

    /// The last episode airing next is the finale, not "a new episode".
    func testFinaleBeatsAnEpisodeOnTheSameDay() {
        let shows = [show(1, "The Pitt", premiere: "2026-08-20", finale: "2026-08-20",
                          seasonPremiere: "2026-07-01")]
        XCTAssertEqual(ShowCalendar.next(from: shows, on: today, calendar: cal)?.kind, .finale)
    }

    func testPastDatesAreDropped() {
        let shows = [show(1, "Shrinking", premiere: "2026-08-09", finale: "2026-07-01")]
        XCTAssertTrue(ShowCalendar.upcoming(from: shows, on: today, calendar: cal).isEmpty)
    }

    // MARK: What stays off it

    func testArchivedAndUntrackedListsAreExcluded() {
        let shows = [
            show(1, "Archived", premiere: "2026-08-12", archived: 1),
            show(2, "Loved", list: .recommending, premiere: "2026-08-12"),
            show(3, "Next Up", list: .next, premiere: "2026-08-12"),
            show(4, "Awaiting", list: .waiting, premiere: "2026-08-13"),
        ]
        let items = ShowCalendar.upcoming(from: shows, on: today, calendar: cal)
        XCTAssertEqual(items.map(\.show.id), [4])
    }

    func testUndatedShowsAreExcluded() {
        let shows = [show(1, "No dates yet"), show(2, "Empty string", premiere: "")]
        XCTAssertNil(ShowCalendar.next(from: shows, on: today, calendar: cal))
    }

    // MARK: Ordering

    func testSortedSoonestFirstThenByTitle() {
        let shows = [
            show(3, "Zed", premiere: "2026-08-20"),
            show(1, "Alpha", premiere: "2026-08-20"),
            show(2, "Mid", finale: "2026-08-11"),
        ]
        let items = ShowCalendar.upcoming(from: shows, on: today, calendar: cal)
        XCTAssertEqual(items.map(\.show.id), [2, 1, 3])
    }

    /// Ids carry the kind, so a premiere and a finale never collide in a
    /// ForEach even if the same show contributes both in some future view.
    func testIdentityIncludesKind() {
        let s = show(1, "Dual", premiere: "2026-08-15", finale: "2026-08-20")
        let premiere = ShowCalendar.DatedShow(show: s, date: today, day: "2026-08-15", kind: .premiere)
        let finale = ShowCalendar.DatedShow(show: s, date: today, day: "2026-08-20", kind: .finale)
        XCTAssertNotEqual(premiere.id, finale.id)
    }

    // MARK: Day parsing

    /// Days are parsed in the device time zone, not UTC — otherwise a member
    /// west of UTC loses today's date and every row displays a day early.
    func testDaysParseAsLocalMidnight() {
        let d = ShowCalendar.day("2026-08-10")
        XCTAssertNotNil(d)
        XCTAssertEqual(d, cal.startOfDay(for: d!))
        XCTAssertNil(ShowCalendar.day(nil))
        XCTAssertNil(ShowCalendar.day(""))
    }
}
