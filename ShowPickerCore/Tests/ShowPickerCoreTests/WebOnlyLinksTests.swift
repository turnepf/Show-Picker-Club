import XCTest
@testable import ShowPickerCore

final class WebOnlyLinksTests: XCTestCase {
    private func web(_ s: String) -> Bool { WebOnlyLinks.isWebOnly(URL(string: "https://showpicker.club" + s)!) }

    // The case that shipped broken: Claude's sign-in page, reached through a
    // device still holding the association file from before /oauth/* was
    // excluded, opened the app and stopped there.
    func testAIAppSignInBelongsToTheBrowser() {
        XCTAssertTrue(web("/oauth/authorize?response_type=code&client_id=abc"))
        XCTAssertTrue(web("/oauth/token"))
        XCTAssertTrue(web("/connect"))
        XCTAssertTrue(web("/connected-apps"))
        XCTAssertTrue(web("/mcp"))
    }

    // What the app does render must never be bounced out of it.
    func testAppRoutesStayInTheApp() {
        XCTAssertFalse(web("/"))
        XCTAssertFalse(web("/patrick"))
        XCTAssertFalse(web("/show/123?title=Fargo"))
        XCTAssertFalse(web("/groups/join?token=x"))
        XCTAssertFalse(web("/household/join?code=x"))
    }

    // The three AASA pattern shapes mean different things.
    func testPatternShapes() {
        XCTAssertTrue(web("/api/shows"))
        XCTAssertFalse(web("/apis"))          // "/api/*" is under /api/, not a prefix
        XCTAssertTrue(web("/vibe?member=x"))
        XCTAssertTrue(web("/vibe-admin"))     // "/vibe*" is a plain prefix
        XCTAssertFalse(web("/connecticut"))   // "/connect" is exact
        XCTAssertTrue(web("/connect/"))
    }
}
