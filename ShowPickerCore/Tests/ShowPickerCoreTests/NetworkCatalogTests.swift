import XCTest
import ShowPickerCore

/// Covers the network picker now that its contents arrive over the wire
/// (`GET /api/networks`) instead of being a literal in the app.
///
/// The move buys one thing — a network added on the server shows up in apps
/// already installed — and it introduces one risk: the picker's contents are
/// now a network response, and a network response can be empty, truncated,
/// duplicated, or shaped slightly differently than the build expects. These
/// tests are the guardrail on that trade, and they run on Linux CI because
/// `NetworkCatalog` is Foundation-only.
final class NetworkCatalogTests: XCTestCase {

    private func decode(_ json: String) -> NetworkCatalog? {
        try? JSONDecoder().decode(NetworkCatalog.self, from: Data(json.utf8))
    }

    // MARK: The point of the change

    /// A network the build has never heard of arrives and is offered. This is
    /// the whole reason the list moved to the server; if it ever fails, the
    /// apps are back to waiting on an App Store release.
    func testServerCanAddANetworkThisBuildDoesNotKnow() {
        let fresh = decode("""
        {"version":"34-abc","networks":[
          {"stored":"Netflix","display":"Netflix","section":null,"storefront":false},
          {"stored":"Crave","display":"Crave (Canada)","section":"Canada","storefront":false}
        ]}
        """)
        let catalog = NetworkCatalog.validated(fresh)

        XCTAssertTrue(catalog.contains("Crave"))
        XCTAssertFalse(NetworkCatalog.bundled.contains("Crave"),
                       "the seed is supposed to be older than the server — pick a different example")
        XCTAssertEqual(catalog.version, "34-abc")
    }

    /// And the section header comes with it. Nothing in the client maps a
    /// region to a title, so a region added later needs no app release.
    func testSectionTitlesComeFromTheServer() {
        let fresh = decode("""
        {"version":"v","networks":[
          {"stored":"Netflix","section":null},
          {"stored":"Crave","section":"Canada"},
          {"stored":"CBC Gem","section":"Canada"}
        ]}
        """)
        let sections = NetworkCatalog.validated(fresh).sections

        XCTAssertEqual(sections.count, 2)
        XCTAssertNil(sections[0].title)
        XCTAssertEqual(sections[0].options.map(\.stored), ["Netflix"])
        XCTAssertEqual(sections[1].title, "Canada")
        XCTAssertEqual(sections[1].options.map(\.stored), ["Crave", "CBC Gem"])
    }

    /// Order is the server's, start to finish — a client never sorts a list it
    /// doesn't understand.
    func testServerOrderIsPreserved() {
        let fresh = decode("""
        {"version":"v","networks":[
          {"stored":"Zeta"},{"stored":"Alpha"},{"stored":"Middle"}
        ]}
        """)
        XCTAssertEqual(NetworkCatalog.validated(fresh).names, ["Zeta", "Alpha", "Middle"])
    }

    // MARK: The risk it introduces

    /// The failure this is all built around: a member opens Add Show during a
    /// bad deploy and the picker is empty. A stale list beats no list.
    func testAnEmptyPayloadNeverEmptiesThePicker() {
        XCTAssertEqual(NetworkCatalog.validated(decode(#"{"version":"v","networks":[]}"#)).names,
                       NetworkCatalog.bundled.names)
        XCTAssertEqual(NetworkCatalog.validated(nil).names, NetworkCatalog.bundled.names)
    }

    /// Junk in the array is dropped without taking the rest of the list down.
    func testUnusableEntriesAreDroppedNotFatal() {
        let messy = decode("""
        {"version":"v","networks":[
          {"stored":"Netflix"},
          {"stored":""},
          {"stored":"   "},
          {"display":"no stored key at all"},
          {"stored":"Hulu"}
        ]}
        """)
        XCTAssertEqual(NetworkCatalog.validated(messy).names, ["Netflix", "Hulu"])
    }

    /// A name sent twice would otherwise render twice — and in a SwiftUI
    /// ForEach keyed by that name, duplicate ids are undefined behaviour.
    func testDuplicatesCollapseToTheFirst() {
        let doubled = decode("""
        {"version":"v","networks":[
          {"stored":"Netflix","display":"first"},
          {"stored":"Netflix","display":"second"},
          {"stored":"Hulu"}
        ]}
        """)
        let catalog = NetworkCatalog.validated(doubled)
        XCTAssertEqual(catalog.names, ["Netflix", "Hulu"])
        XCTAssertEqual(catalog.networks.first?.display, "first")
    }

    /// A payload where everything is junk is the empty case in disguise.
    func testAllJunkFallsBackToTheSeed() {
        let junk = decode(#"{"version":"v","networks":[{"stored":""},{"stored":"  "}]}"#)
        XCTAssertEqual(NetworkCatalog.validated(junk).names, NetworkCatalog.bundled.names)
    }

    /// An older build has to survive a payload that grew fields, and a newer
    /// server has to survive one that omitted the optional ones.
    func testDecodingToleratesMissingAndUnknownFields() {
        let sparse = decode("""
        {"version":"v","networks":[
          {"stored":"Netflix","unheard_of_field":{"nested":true}}
        ]}
        """)
        let option = NetworkCatalog.validated(sparse).networks.first
        XCTAssertEqual(option?.stored, "Netflix")
        XCTAssertEqual(option?.display, "Netflix", "display defaults to the stored name")
        XCTAssertNil(option?.section)
        XCTAssertFalse(option?.storefront ?? true)
    }

    /// Cached to disk between launches, so it has to survive a round trip
    /// through the encoder as well as the server's own JSON.
    func testRoundTripsThroughItsOwnEncoder() throws {
        let original = NetworkCatalog.validated(decode("""
        {"version":"v1","networks":[
          {"stored":"Netflix","display":"Netflix","section":null,"storefront":false},
          {"stored":"Fandango","display":"Fandango (theatre tickets)","section":"Rent or buy","storefront":true}
        ]}
        """))
        let data = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(NetworkCatalog.self, from: data)

        XCTAssertEqual(decoded, original)
        XCTAssertEqual(decoded.networks.last?.storefront, true)
        XCTAssertEqual(decoded.sections.last?.title, "Rent or buy")
    }

    // MARK: What the editor depends on

    /// A row can carry a network nobody offers — typed into "not listed", or
    /// inherited from enrichment. `contains` is how the editor decides whether
    /// to open on the picker or on the free-text field, so a false positive
    /// would silently rewrite what a member typed.
    func testAnUnlistedNetworkIsNotClaimed() {
        let catalog = NetworkCatalog.validated(decode(#"{"version":"v","networks":[{"stored":"Netflix"}]}"#))
        XCTAssertTrue(catalog.contains("Netflix"))
        XCTAssertFalse(catalog.contains("Channel 12 Toledo"))
        XCTAssertFalse(catalog.contains("netflix"), "canonicalization is the server's job, not a fuzzy match here")
    }

    /// The seed is what a first launch with no signal shows. It has to be a
    /// real, sectioned list rather than a placeholder.
    func testTheBundledSeedIsUsableOnItsOwn() {
        let seed = NetworkCatalog.bundled
        XCTAssertTrue(seed.contains("Netflix"))
        XCTAssertTrue(seed.contains("BBC iPlayer"))
        XCTAssertTrue(seed.contains("Stan"))
        XCTAssertEqual(seed.sections.map(\.title), [nil, "United Kingdom", "Australia", "Rent or buy"])
        XCTAssertEqual(Set(seed.names).count, seed.names.count, "the seed itself must not repeat a name")
        XCTAssertTrue(seed.networks.filter(\.storefront).map(\.stored).contains("Fandango"))
    }
}
