import XCTest
import ShowPickerCore

/// Migration 073's detail-screen rows: the IMDb link, Status, "Free on", and
/// cast characters. Each stays off until enrichment has stored the data —
/// the server fills these as titles come round rather than in one backfill,
/// so for a while most shows have none of them, and a row must not appear
/// half-made in the meantime.
final class TitleFactsTests: XCTestCase {

    private func show(network: String? = nil, imdbId: String? = nil,
                      tmdbStatus: String? = nil, freeOn: String? = nil, movie: Int? = 0) -> Show {
        Show(id: 1, title: "A Title", network: network, list: "watching", movie: movie,
             imdbId: imdbId, tmdbStatus: tmdbStatus, freeOn: freeOn)
    }

    // MARK: TMDB entry

    /// Two shows can share a title (three 2026 films are "The Odyssey"), so
    /// "is this the same show?" needs the entry. Optional: an older server,
    /// or an offline-cached row, may not carry it.
    func testDecodesTheTmdbEntryWhenSentAndToleratesItsAbsence() throws {
        let with = try JSONDecoder().decode(Show.self, from: Data(#"{"id":1,"title":"The Odyssey","list":"loved","movie":1,"tmdb_id":1368337}"#.utf8))
        XCTAssertEqual(with.tmdbId, 1368337)
        let without = try JSONDecoder().decode(Show.self, from: Data(#"{"id":2,"title":"The Odyssey","list":"loved","movie":1}"#.utf8))
        XCTAssertNil(without.tmdbId)
    }

    // MARK: IMDb

    func testImdbLinkPointsAtTheTitlePage() {
        XCTAssertEqual(show(imdbId: "tt11280740").imdbURL?.absoluteString,
                       "https://www.imdb.com/title/tt11280740/")
    }

    func testNoImdbLinkUntilAnIdIsStored() {
        XCTAssertNil(show().imdbURL)
        XCTAssertNil(show(imdbId: "").imdbURL)
    }

    /// The id goes straight into a URL, so anything not shaped like one is
    /// refused here as well as on the server.
    func testMalformedImdbIdGivesNoLink() {
        XCTAssertNil(show(imdbId: "tt").imdbURL)
        XCTAssertNil(show(imdbId: "nm0000001").imdbURL)
        XCTAssertNil(show(imdbId: "tt123/../x").imdbURL)
    }

    // MARK: Status

    func testStatusWording() {
        XCTAssertEqual(show(tmdbStatus: "Returning Series").statusText, "Returning")
        XCTAssertEqual(show(tmdbStatus: "Ended").statusText, "Ended")
        XCTAssertEqual(show(tmdbStatus: "Canceled").statusText, "Canceled")
        XCTAssertEqual(show(tmdbStatus: "In Production").statusText, "In production")
        XCTAssertEqual(show(tmdbStatus: "Planned").statusText, "Planned")
    }

    /// Every film on a list has been released; a row saying so is noise.
    func testReleasedFilmHasNoStatusRow() {
        XCTAssertNil(show(tmdbStatus: "Released", movie: 1).statusText)
    }

    /// Not stored yet, or stored as '' because TMDB sent none: no row either way.
    func testNoStatusRowWithoutAStatus() {
        XCTAssertNil(show().statusText)
        XCTAssertNil(show(tmdbStatus: "").statusText)
    }

    func testUnknownStatusIsShownAsWritten() {
        XCTAssertEqual(show(tmdbStatus: "Something New").statusText, "Something New")
    }

    // MARK: Free on

    func testFreeServicesListed() {
        XCTAssertEqual(show(network: "Netflix", freeOn: "Tubi, Pluto TV").freeOnText, "Tubi, Pluto TV")
    }

    /// The member's own network is already on the row above.
    func testFreeRowLeavesOutTheirOwnNetwork() {
        XCTAssertEqual(show(network: "Pluto TV", freeOn: "Pluto TV, Tubi").freeOnText, "Tubi")
        XCTAssertNil(show(network: "Pluto TV", freeOn: "Pluto TV").freeOnText)
    }

    /// Never asked (nil) and asked-but-none ("") both show nothing.
    func testNoFreeRowWithoutFreeServices() {
        XCTAssertNil(show(freeOn: nil).freeOnText)
        XCTAssertNil(show(freeOn: "").freeOnText)
    }

    // MARK: Decoding

    func testShowDecodesTheNewFields() throws {
        let json = #"{"id":1,"title":"Severance","imdb_id":"tt11280740","tmdb_status":"Returning Series","free_on":"Tubi"}"#
        let s = try JSONDecoder().decode(Show.self, from: Data(json.utf8))
        XCTAssertEqual(s.imdbId, "tt11280740")
        XCTAssertEqual(s.tmdbStatus, "Returning Series")
        XCTAssertEqual(s.freeOn, "Tubi")
    }

    /// An older server, or a row not yet enriched, sends none of them.
    func testShowDecodesWithoutTheNewFields() throws {
        let s = try JSONDecoder().decode(Show.self, from: Data(#"{"id":1,"title":"Severance"}"#.utf8))
        XCTAssertNil(s.imdbId)
        XCTAssertNil(s.statusText)
        XCTAssertNil(s.freeOnText)
    }

    func testActorDecodesCharacterWhenPresentAndAbsent() throws {
        let withRole = try JSONDecoder().decode(
            Actor.self, from: Data(#"{"name":"Adam Scott","imdb_id":"nm0778014","character":"Mark S."}"#.utf8))
        XCTAssertEqual(withRole.character, "Mark S.")
        let without = try JSONDecoder().decode(
            Actor.self, from: Data(#"{"name":"Adam Scott","imdb_id":null,"character":null}"#.utf8))
        XCTAssertNil(without.character)
        let legacy = try JSONDecoder().decode(Actor.self, from: Data(#"{"name":"Adam Scott"}"#.utf8))
        XCTAssertNil(legacy.character)
    }
}
