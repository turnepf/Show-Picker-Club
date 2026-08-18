import Foundation

/// The network picker's contents, as the server hands them over.
///
/// This used to be a `[String]` literal in the iOS app. That meant a network
/// added to `functions/_shared/networks.js` reached a member only when they
/// installed a new App Store build — weeks after the change at best, never for
/// anyone who doesn't update. `GET /api/networks` now serves the list and this
/// type is what the app renders, so adding a network is a server change.
///
/// Living in ShowPickerCore rather than the app target is deliberate: it is
/// Foundation-only, so the rules below are compiled and tested on Linux CI
/// (`swift test`) instead of being verified by opening Xcode.
///
/// Three rules make it safe to render a list that arrives over the wire, and
/// they fail independently:
///
/// 1. **A bad payload never empties the picker.** `validated()` falls back to
///    `bundled` whenever the server sends nothing usable. The failure mode this
///    prevents is a member opening Add Show mid-deploy and finding no networks
///    at all — strictly worse than a slightly stale list.
/// 2. **Sections come from the server, not from a client-side region map.**
///    A client groups consecutive entries by the `section` string it is handed
///    and renders that string as the header, so a region added later needs no
///    app release either. Nothing here knows what "United Kingdom" means.
/// 3. **The bundled list is a seed, not a source of truth.** It exists so a
///    first launch with no signal still has a picker. It is allowed to be
///    shorter than the server's; it must never contain a name the server
///    doesn't (`scripts/networks-test.mjs` checks that direction).
public struct NetworkCatalog: Codable, Equatable, Sendable {

    /// Content hash from the server, for telling "same list as last time" and
    /// for naming a stale cache in a bug report. Empty for the bundled seed.
    public let version: String

    /// Every option, in the order the server sent them — which is the order a
    /// picker shows them.
    public let networks: [NetworkOption]

    public init(version: String = "", networks: [NetworkOption]) {
        self.version = version
        self.networks = networks
    }

    /// Canonical names only, for callers that just need "is this one of ours"
    /// or a flat list (the admin URL-cleanup picker).
    public var names: [String] { networks.map(\.stored) }

    /// Whether a stored network name is one the server would canonicalize.
    /// A member's existing row can carry something else entirely — typed into
    /// the "not listed" field, or inherited from enrichment — and an editor has
    /// to keep that value rather than silently swapping it for a picker entry.
    public func contains(_ name: String) -> Bool {
        networks.contains { $0.stored == name }
    }

    /// One header plus its rows. `title == nil` is the unlabelled first group.
    public struct Section: Equatable, Sendable, Identifiable {
        public let title: String?
        public let options: [NetworkOption]
        /// Stable within a catalog: the server emits each section once, as a
        /// consecutive run.
        public var id: String { title ?? "" }

        public init(title: String?, options: [NetworkOption]) {
            self.title = title
            self.options = options
        }
    }

    /// Consecutive runs of the same `section`, in server order. Grouping by
    /// runs rather than by collecting every matching entry is what keeps this
    /// honest: the rendered order is exactly the order that arrived, and a
    /// client never reorders a list it doesn't understand.
    public var sections: [Section] {
        var result: [Section] = []
        var openTitle: String? = nil
        var openOptions: [NetworkOption] = []
        // Tracked separately from `openTitle`, which is legitimately nil for
        // the unlabelled first group.
        var hasOpenRun = false

        for option in networks {
            if hasOpenRun && openTitle == option.section {
                openOptions.append(option)
            } else {
                if hasOpenRun { result.append(Section(title: openTitle, options: openOptions)) }
                openTitle = option.section
                openOptions = [option]
                hasOpenRun = true
            }
        }
        if hasOpenRun { result.append(Section(title: openTitle, options: openOptions)) }
        return result
    }

    /// A usable catalog from whatever arrived. Drops nameless and duplicate
    /// entries, and falls back to `bundled` when what's left is empty — the one
    /// outcome a picker can't survive.
    public static func validated(_ candidate: NetworkCatalog?) -> NetworkCatalog {
        guard let candidate else { return bundled }
        var seen = Set<String>()
        let cleaned = candidate.networks.filter { option in
            let name = option.stored.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else { return false }
            return seen.insert(name).inserted
        }
        guard !cleaned.isEmpty else { return bundled }
        return NetworkCatalog(version: candidate.version, networks: cleaned)
    }

    /// The list as it stood when this build shipped, for a first launch with no
    /// signal. Kept flat and name-only — `display` defaults to the stored name,
    /// which is what the picker draws anyway.
    ///
    /// Alphabetical within each section, case-insensitively, matching the order
    /// `networkCatalog()` serves — so the picker doesn't visibly reshuffle the
    /// moment the first fetch lands.
    public static let bundled = NetworkCatalog(networks: [
        // United States (the unlabelled first group).
        NetworkOption("Amazon Prime Video"), NetworkOption("AMC+"),
        NetworkOption("Apple TV+"), NetworkOption("BritBox"),
        NetworkOption("Disney+"), NetworkOption("Food Network"),
        NetworkOption("Fox"), NetworkOption("HBO Max"),
        NetworkOption("Hulu"), NetworkOption("MGM+"),
        NetworkOption("Netflix"), NetworkOption("Paramount+"),
        NetworkOption("PBS"), NetworkOption("Peacock"),
        NetworkOption("Pluto TV"), NetworkOption("Starz"),
        NetworkOption("YouTube"),
        // United Kingdom.
        NetworkOption("BBC iPlayer", section: "United Kingdom"),
        NetworkOption("Channel 4", section: "United Kingdom"),
        NetworkOption("Channel 5", section: "United Kingdom"),
        NetworkOption("ITVX", section: "United Kingdom"),
        NetworkOption("NOW", section: "United Kingdom"),
        // Australia.
        NetworkOption("10 play", section: "Australia"),
        NetworkOption("7plus", section: "Australia"),
        NetworkOption("9Now", section: "Australia"),
        NetworkOption("ABC iview", section: "Australia"),
        NetworkOption("Binge", section: "Australia"),
        NetworkOption("Foxtel", section: "Australia"),
        NetworkOption("SBS On Demand", section: "Australia"),
        NetworkOption("Stan", section: "Australia"),
        // Storefronts.
        NetworkOption("Apple TV Store", section: "Rent or buy", storefront: true),
        NetworkOption("Fandango", section: "Rent or buy", storefront: true),
        NetworkOption("Fandango at Home", section: "Rent or buy", storefront: true),
    ])
}

/// One row of the picker.
public struct NetworkOption: Codable, Hashable, Sendable, Identifiable {

    /// Exactly what gets written to `shows.network`. Also what a picker draws:
    /// `display` carries the server's parenthetical sub-brand hint ("Paramount+
    /// (including CBS, MTV, …)"), which is right for a web `<select>` and far
    /// too long for a row in an iOS menu.
    public let stored: String

    /// The longer label, with sub-brand hints. Defaults to `stored`.
    public let display: String

    /// Which picker section this belongs in; `nil` is the unlabelled first
    /// group. An opaque string on purpose — see the type doc.
    public let section: String?

    /// Rent/buy rather than a subscription. Clients that price things (the
    /// Subscription Audit) skip these.
    public let storefront: Bool

    public var id: String { stored }

    public init(_ stored: String, display: String? = nil, section: String? = nil, storefront: Bool = false) {
        self.stored = stored
        self.display = display ?? stored
        self.section = section
        self.storefront = storefront
    }

    // Hand-written so the payload can grow fields without breaking an older
    // build, and so a server that omits an optional one still decodes. An
    // entry with no `stored` is the only unusable shape, and `validated()`
    // drops those rather than failing the whole list.
    private enum CodingKeys: String, CodingKey {
        case stored, display, section, storefront
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let stored = try c.decodeIfPresent(String.self, forKey: .stored) ?? ""
        self.stored = stored
        self.display = try c.decodeIfPresent(String.self, forKey: .display) ?? stored
        self.section = try c.decodeIfPresent(String.self, forKey: .section)
        self.storefront = try c.decodeIfPresent(Bool.self, forKey: .storefront) ?? false
    }
}
