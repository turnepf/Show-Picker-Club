import XCTest
import ShowPickerCore

/// Regression tests for the 2026-08 logout bug: the iPad/Mac sidebar kept
/// drawing a signed-in nav after logout, including the member roster with each
/// member's show count, and every row 401'd on tap.
///
/// These run on Linux CI via `swift test` — `SessionScope` is deliberately
/// Foundation-only so catching this class of bug doesn't need a macOS runner.
final class SessionScopeTests: XCTestCase {

    private var populated: SessionScope {
        SessionScope(focusedSlug: "patrick",
                     groupMemberSlugs: ["quinn", "sherry"],
                     backlogCount: 12)
    }

    func testFreshScopeIsEmpty() {
        XCTAssertTrue(SessionScope().isEmpty)
        XCTAssertNil(SessionScope().focusedSlug)
        XCTAssertEqual(SessionScope().groupMemberSlugs, [])
        XCTAssertEqual(SessionScope().backlogCount, 0)
    }

    func testPopulatedScopeIsNotEmpty() {
        XCTAssertFalse(populated.isEmpty)
    }

    /// The teardown itself. Equality is synthesized across every stored
    /// property, so this also fails if someone adds a field that `clear()`
    /// leaves behind.
    func testClearDropsEveryField() {
        var scope = populated
        scope.clear()
        XCTAssertEqual(scope, SessionScope())
        XCTAssertTrue(scope.isEmpty)
    }

    /// The actual regression. Stale group slugs must not produce a visible
    /// roster once there is no signed-in member — this is the assertion that
    /// would have failed against the shipped Mac build.
    func testSignedOutSeesNobodyEvenWithStaleGroupMembers() {
        XCTAssertEqual(populated.visibleMemberSlugs(mySlug: nil), [])
    }

    func testSignedInSeesGroupMembersPlusSelf() {
        XCTAssertEqual(populated.visibleMemberSlugs(mySlug: "patrick"),
                       ["patrick", "quinn", "sherry"])
    }

    /// Signing in as someone with no groups shows only them — the roster is
    /// scoped to groups, not to the whole club.
    func testSignedInWithNoGroupsSeesOnlySelf() {
        var scope = populated
        scope.clear()
        XCTAssertEqual(scope.visibleMemberSlugs(mySlug: "patrick"), ["patrick"])
    }

    /// Teardown and visibility are independent guards: either one alone keeps
    /// the roster off a logged-out screen.
    func testClearedScopeSignedOutSeesNobody() {
        var scope = populated
        scope.clear()
        XCTAssertEqual(scope.visibleMemberSlugs(mySlug: nil), [])
    }
}
