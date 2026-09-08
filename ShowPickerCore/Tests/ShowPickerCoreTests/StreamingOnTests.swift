import XCTest
import ShowPickerCore

/// Where a title streams *now*, shown beside the member's own network rather
/// than replacing it (migration 069, `docs/INVARIANTS.md` §20).
///
/// `shows.network` is written fill-only by both enrichment passes, so once set
/// it is never revisited and drifts as licensing moves: 61 of 137 unarchived
/// films carried a network TMDB no longer listed. Overwriting it would discard
/// deliberate member answers — nothing records whether a value came from the
/// member or from TMDB — so `streaming_on` carries TMDB's current answer
/// alongside and the UI states the difference.
///
/// The rule under test is `Show.streamingNote`, which decides what (if
/// anything) that line says. The cases worth pinning are the ones where saying
/// the wrong thing is worse than saying nothing.
final class StreamingOnTests: XCTestCase {

    private func show(network: String?, streamingOn: String?) -> Show {
        Show(id: 1, title: "A Film", network: network, list: "next", streamingOn: streamingOn)
    }

    /// The member watches it on Max; TMDB also lists Hulu. Their answer stands
    /// and the extra service is additional information, not a correction.
    func testNamesTheOtherServicesWhenTheirsIsAmongThem() {
        let s = show(network: "HBO Max", streamingOn: "HBO Max, Hulu")
        XCTAssertEqual(s.streamingNote, "Also on Hulu")
    }

    /// Their network is the only one listed — there is nothing to add, so the
    /// line stays off rather than restating the network above it.
    func testSaysNothingWhenTheirsIsTheOnlyService() {
        let s = show(network: "Netflix", streamingOn: "Netflix")
        XCTAssertNil(s.streamingNote)
    }

    /// The staleness case this column exists for: the card says Netflix,
    /// licensing moved, TMDB now says Paramount+. "Now on" rather than "Also
    /// on", because their network is not among them.
    func testSaysNowOnWhenTheirNetworkIsNoLongerListed() {
        let s = show(network: "Netflix", streamingOn: "Paramount+")
        XCTAssertEqual(s.streamingNote, "Now on Paramount+")
    }

    /// Empty means TMDB was asked and named no subscription service — ordinary
    /// for a rental. Nothing to say, and nothing that contradicts the card.
    func testSaysNothingWhenTmdbNamedNoService() {
        XCTAssertNil(show(network: "Apple TV Store", streamingOn: "").streamingNote)
    }

    /// nil means nobody ever asked. It must read the same as "asked, found
    /// none" — never as an assertion that the title streams nowhere, which
    /// would be claiming a fact we never checked.
    func testSaysNothingWhenTmdbWasNeverAsked() {
        XCTAssertNil(show(network: "Netflix", streamingOn: nil).streamingNote)
    }

    /// A row with no network of its own still gets the useful half.
    func testNamesServicesWhenTheRowHasNoNetwork() {
        let s = show(network: nil, streamingOn: "Hulu, Peacock")
        XCTAssertEqual(s.streamingNote, "Now on Hulu, Peacock")
    }

    /// The server canonicalizes both sides, but a legacy row can hold "Max"
    /// where the table says "HBO Max". Matching case-insensitively keeps that
    /// from reading as a service change when nothing changed.
    func testMatchesTheNetworkCaseInsensitively() {
        let s = show(network: "hbo max", streamingOn: "HBO Max, Hulu")
        XCTAssertEqual(s.streamingNote, "Also on Hulu")
    }

    /// Decoding: the field arrives as `streaming_on`, and a payload without it
    /// — an older cached row, another member's list — must decode cleanly to
    /// nil rather than failing the whole show.
    func testDecodesFromSnakeCaseAndToleratesAbsence() throws {
        let with = try JSONDecoder().decode(Show.self, from: Data("""
        {"id":1,"title":"A Film","list":"next","network":"Netflix","streaming_on":"Hulu"}
        """.utf8))
        XCTAssertEqual(with.streamingOnList, ["Hulu"])
        XCTAssertEqual(with.streamingNote, "Now on Hulu")

        let without = try JSONDecoder().decode(Show.self, from: Data("""
        {"id":1,"title":"A Film","list":"next","network":"Netflix"}
        """.utf8))
        XCTAssertNil(without.streamingOn)
        XCTAssertNil(without.streamingNote)
    }
}
