import XCTest

// Unit tests for the share-sheet title normalization (ShareTitleParser). The
// parser source is compiled directly into this test target (same pattern as
// SharedSession.swift), so no module import is needed.
final class ShareTitleParserTests: XCTestCase {

    // MARK: Known streaming share templates

    func testParamountWrapperReducesToTitle() {
        let raw = "Hey! Thought you\u{2019}d like The Amazing Race on Paramount+. Check it out\u{2026}"
        let result = ShareTitleParser.parse(text: raw, url: nil)
        XCTAssertEqual(result.title, "The Amazing Race")
        XCTAssertEqual(result.network, "Paramount+")
    }

    func testHBOMaxStreamWrapperReducesToTitle() {
        // Title contains a period that must survive ("St.").
        let raw = "Stream DTF St. Louis on HBO Max"
        let result = ShareTitleParser.parse(text: raw, url: nil)
        XCTAssertEqual(result.title, "DTF St. Louis")
        XCTAssertEqual(result.network, "HBO Max")
    }

    func testHuluWrapperWithCommasApostropheAndURL() {
        // Commas and an apostrophe in the title, plus a trailing utm-tagged URL.
        let raw = "Check out Good Luck, Have Fun, Don't Die on Hulu! "
            + "https://www.hulu.com/movie/39d9aea5-a4f3-44b1-9d6c-539ff6fe3bef?play=false&utm_source=shared_link"
        let url = URL(string: "https://www.hulu.com/movie/39d9aea5-a4f3-44b1-9d6c-539ff6fe3bef?play=false&utm_source=shared_link")
        let result = ShareTitleParser.parse(text: raw, url: url)
        XCTAssertEqual(result.title, "Good Luck, Have Fun, Don't Die")
        XCTAssertEqual(result.network, "Hulu")
    }

    func testNetflixQuotedTitle() {
        let raw = "Check out \u{201C}I Will Find You\u{201D} on Netflix https://www.netflix.com/title/81234567"
        let url = URL(string: "https://www.netflix.com/title/81234567")
        let result = ShareTitleParser.parse(text: raw, url: url)
        XCTAssertEqual(result.title, "I Will Find You")
        XCTAssertEqual(result.network, "Netflix")
    }

    // MARK: Edge cases that must keep working

    func testPlainTitleIsLeftUnchanged() {
        let result = ShareTitleParser.parse(text: "Severance", url: nil)
        XCTAssertEqual(result.title, "Severance")
        XCTAssertNil(result.network)
    }

    func testPlainTitleStartingWithVerbIsNotMangled() {
        // "Watch What Happens Live" must not lose its leading "Watch": no URL and
        // no detected network means there's no streaming context to strip against.
        let result = ShareTitleParser.parse(text: "Watch What Happens Live", url: nil)
        XCTAssertEqual(result.title, "Watch What Happens Live")
    }

    func testTitleStartingWithVerbWordButNoBoundary() {
        // "Watchmen" must not be mistaken for the verb "watch".
        let result = ShareTitleParser.parse(text: "Watchmen", url: nil)
        XCTAssertEqual(result.title, "Watchmen")
    }

    func testTitleContainingOnIsNotTruncatedWhenPlain() {
        // A bare title with " on " in it stays intact when it's not a wrapper.
        let result = ShareTitleParser.parse(text: "Based on a True Story", url: nil)
        XCTAssertEqual(result.title, "Based on a True Story")
    }

    func testStandaloneURLIsStrippedFromTitle() {
        let raw = "Severance https://www.appletv.com/foo"
        let url = URL(string: "https://www.appletv.com/foo")
        let result = ShareTitleParser.parse(text: raw, url: url)
        XCTAssertEqual(result.title, "Severance")
    }

    func testAppleTVURLSlugBecomesTitleWhenNoText() {
        let url = URL(string: "https://tv.apple.com/us/show/ted-lasso/umc.cmc.id")
        let result = ShareTitleParser.parse(text: nil, url: url)
        XCTAssertEqual(result.title, "Ted Lasso")
        XCTAssertEqual(result.network, "Apple TV+")
    }

    func testNetworkFromURLHostTakesPrecedence() {
        let url = URL(string: "https://www.netflix.com/title/80238270")
        let result = ShareTitleParser.parse(text: "Wednesday", url: url)
        XCTAssertEqual(result.title, "Wednesday")
        XCTAssertEqual(result.network, "Netflix")
    }

    func testEmptyAndWhitespaceYieldNoTitle() {
        XCTAssertNil(ShareTitleParser.parse(text: "   ", url: nil).title)
        XCTAssertNil(ShareTitleParser.parse(text: nil, url: nil).title)
    }
}
