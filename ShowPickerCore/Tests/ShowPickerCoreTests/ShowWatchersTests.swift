import XCTest
import ShowPickerCore

/// Decoding for "Watching with" once it can name club members rather than only
/// free text (migration 064).
///
/// `watching_with` stays the display string and `watchers` is the structured
/// half beside it, sent only on the owner's own rows. That split is what makes
/// the field safe to extend: an older client that never heard of `watchers`
/// keeps rendering `watching_with` and is right, and a new client that gets a
/// payload without `watchers` — another member's list, a logged-out card, a
/// row read from the offline cache — has to degrade to the same place rather
/// than failing the decode.
///
/// `Show`'s tolerant decoder exists precisely because one unexpected field
/// shape used to blank a whole screen (see the comment on `init(from:)`), so
/// the case worth pinning is that adding this field didn't reintroduce that.
final class ShowWatchersTests: XCTestCase {

    private func decode(_ json: String) throws -> Show {
        try JSONDecoder().decode(Show.self, from: Data(json.utf8))
    }

    func testWatchersDecodeAlongsideTheDisplayString() throws {
        let show = try decode("""
        {"id": 1, "title": "The Bear", "list": "watching",
         "watching_with": "my sister, Quinn",
         "watchers": [{"slug": "quinn", "name": "Quinn"}]}
        """)
        XCTAssertEqual(show.watchingWith, "my sister, Quinn")
        XCTAssertEqual(show.watchers?.count, 1)
        XCTAssertEqual(show.watchers?.first?.slug, "quinn")
        XCTAssertEqual(show.watchers?.first?.name, "Quinn")
    }

    /// Another member's copy carries neither field. Both come back nil and the
    /// rest of the row decodes — the show still has to render.
    func testAbsentWatchersDecodeToNilWithoutFailingTheRow() throws {
        let show = try decode("""
        {"id": 2, "title": "Severance", "list": "watching", "poster_url": "https://example.com/p.jpg"}
        """)
        XCTAssertNil(show.watchers)
        XCTAssertNil(show.watchingWith)
        XCTAssertEqual(show.title, "Severance")
        XCTAssertEqual(show.posterUrl, "https://example.com/p.jpg")
    }

    /// An empty list is a real answer — "nobody is named" — and must not be
    /// confused with the field being absent.
    func testEmptyWatchersIsNotNil() throws {
        let show = try decode("""
        {"id": 3, "title": "Andor", "list": "watching", "watchers": []}
        """)
        XCTAssertEqual(show.watchers?.count, 0)
    }

    /// Free text with nobody linked: the field works exactly as it always has.
    func testFreeTextAloneStillWorks() throws {
        let show = try decode("""
        {"id": 4, "title": "Shrinking", "list": "watching", "watching_with": "my sister", "watchers": []}
        """)
        XCTAssertEqual(show.watchingWith, "my sister")
        XCTAssertEqual(show.watchers, [])
    }

    /// A malformed `watchers` must cost the field, not the show. The tolerant
    /// decoder's whole reason for existing.
    func testMalformedWatchersDoesNotFailTheWholeShow() throws {
        let show = try decode("""
        {"id": 5, "title": "Fargo", "list": "watching", "watchers": "Quinn"}
        """)
        XCTAssertNil(show.watchers)
        XCTAssertEqual(show.title, "Fargo")
        XCTAssertEqual(show.list, "watching")
    }

    /// A copy created by someone else's tag names its creator, so a title the
    /// owner never added can explain why it's on their list. Owner-only, and
    /// absent on rows the owner added themselves.
    func testAddedByMemberDecodes() throws {
        let show = try decode("""
        {"id": 7, "title": "Fruitvale Station", "list": "watching",
         "watching_with": "Patrick",
         "added_by_member": {"slug": "patrick", "name": "Patrick"}}
        """)
        XCTAssertEqual(show.addedByMember?.slug, "patrick")
        XCTAssertEqual(show.addedByMember?.name, "Patrick")
    }

    /// Absent on your own adds and on every payload from an older server —
    /// nil, with the rest of the row intact. Malformed costs the field, not
    /// the show, same rule as `watchers`.
    func testAbsentOrMalformedAddedByMemberDoesNotFailTheRow() throws {
        let own = try decode("""
        {"id": 8, "title": "Heat", "list": "loved"}
        """)
        XCTAssertNil(own.addedByMember)
        XCTAssertEqual(own.title, "Heat")

        let mangled = try decode("""
        {"id": 9, "title": "Ronin", "list": "loved", "added_by_member": "patrick"}
        """)
        XCTAssertNil(mangled.addedByMember)
        XCTAssertEqual(mangled.title, "Ronin")
    }

    /// Round-trips through the offline cache, which encodes and re-decodes
    /// whole `Show` values.
    func testRoundTrip() throws {
        let original = Show(id: 6, title: "Dune", list: "watching",
                            watchingWith: "Amy, Quinn",
                            watchers: [ShowWatcher(slug: "amy", name: "Amy"),
                                       ShowWatcher(slug: "quinn", name: "Quinn")],
                            addedByMember: ShowWatcher(slug: "amy", name: "Amy"))
        let back = try JSONDecoder().decode(Show.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(back.watchers, original.watchers)
        XCTAssertEqual(back.watchingWith, "Amy, Quinn")
        XCTAssertEqual(back.addedByMember, original.addedByMember)
    }
}
