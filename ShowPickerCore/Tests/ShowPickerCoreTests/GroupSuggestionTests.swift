import XCTest
import ShowPickerCore

/// Decoding for a group's recommendation board ("Recommend to group",
/// migration 065).
///
/// The server shapes each card for the viewing member, and the client's whole
/// pop-up logic hangs off two derived facts: `needsResponse` (not my card,
/// not yet answered) and the 1/0 integers D1 sends where JSON would say
/// true/false. The cases worth pinning are the ones a happy-path decode
/// would never exercise: integer booleans, nulls where snapshots ran dry,
/// and a payload missing the viewer-shaping fields entirely.
final class GroupSuggestionTests: XCTestCase {

    private func decode(_ json: String) throws -> GroupSuggestion {
        try JSONDecoder().decode(GroupSuggestion.self, from: Data(json.utf8))
    }

    func testFullCardDecodes() throws {
        let s = try decode("""
        {"id": 7, "group_id": 3, "show_id": 42, "title": "Lanterns",
         "tmdb_id": 111, "movie": 0,
         "poster_url": "https://image.tmdb.org/lanterns.jpg",
         "network": "HBO Max", "note": "Trust me on this one",
         "created_at": "2026-08-25 12:00:00",
         "suggested_by": "jc", "suggested_by_name": "JC",
         "is_yours": 0, "your_response": null,
         "added_count": 2, "added_names": ["Amy", "Quinn"],
         "on_your_list": null}
        """)
        XCTAssertEqual(s.title, "Lanterns")
        XCTAssertEqual(s.suggestedByName, "JC")
        XCTAssertEqual(s.showId, 42)
        XCTAssertFalse(s.isMovie)
        XCTAssertFalse(s.isYours)
        XCTAssertEqual(s.addedNames, ["Amy", "Quinn"])
        XCTAssertTrue(s.needsResponse, "unanswered, not mine — the pop-up should ask")
    }

    func testIntegerBooleansReadAsBooleans() throws {
        let mine = try decode("""
        {"id": 1, "title": "Dune", "movie": 1, "is_yours": 1,
         "suggested_by": "patrick", "suggested_by_name": "Patrick"}
        """)
        XCTAssertTrue(mine.isMovie)
        XCTAssertTrue(mine.isYours)
        XCTAssertFalse(mine.needsResponse, "your own card never asks you")
    }

    func testAnsweredCardStopsAsking() throws {
        let s = try decode("""
        {"id": 2, "title": "Severance", "is_yours": 0,
         "your_response": "dismissed",
         "suggested_by": "quinn", "suggested_by_name": "Quinn"}
        """)
        XCTAssertEqual(s.yourResponse, "dismissed")
        XCTAssertFalse(s.needsResponse)
    }

    func testSparseCardStillDecodes() throws {
        // A card whose source copy was deleted (show_id null) and whose
        // snapshot never had a poster — plus none of the viewer-shaping
        // fields. Absent must mean default, not a failed board.
        let s = try decode("""
        {"id": 3, "title": "Poker Face", "show_id": null, "poster_url": null,
         "suggested_by": "amy"}
        """)
        XCTAssertNil(s.showId)
        XCTAssertNil(s.posterUrl)
        XCTAssertEqual(s.suggestedByName, "amy", "falls back to the slug")
        XCTAssertEqual(s.addedCount, 0)
        XCTAssertTrue(s.addedNames.isEmpty)
        XCTAssertTrue(s.needsResponse)
    }

    func testBoardPayloadDecodes() throws {
        let board = try JSONDecoder().decode(GroupSuggestionsResponse.self, from: Data("""
        {"suggestions": [
          {"id": 1, "title": "Lanterns", "suggested_by": "jc", "suggested_by_name": "JC", "is_yours": 0},
          {"id": 2, "title": "Dune", "suggested_by": "patrick", "suggested_by_name": "Patrick", "is_yours": 1}
        ]}
        """.utf8))
        XCTAssertEqual(board.suggestions.count, 2)
        XCTAssertEqual(board.suggestions.filter(\.needsResponse).map(\.id), [1],
                       "the pop-up queue is exactly the unanswered cards that aren't mine")
    }
}
