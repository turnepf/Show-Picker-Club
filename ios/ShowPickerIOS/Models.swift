import Foundation

// Mirrors the JSON shapes returned by showpicker.club. Same schema as the
// tvOS client; iPhone gets the extra write paths (POST/PUT) below.

// Someone you share a private group with — the candidate list for "Watching
// with" (/api/group-members). Deliberately not a `Member`: this carries no
// show counts or calendar token, only who they are and which of your groups
// puts them in front of you.
struct GroupMate: Codable, Identifiable, Hashable {
    var id: String { slug }
    let slug: String
    let name: String
    let groups: [String]?

    // Why they're on the list, for members in more than one group. A single
    // shared group needs no explanation.
    var groupsLabel: String? {
        guard let groups, !groups.isEmpty else { return nil }
        return groups.joined(separator: ", ")
    }
}

struct Member: Codable, Identifiable, Hashable {
    var id: String { slug }
    let slug: String
    let name: String
    let firstName: String?
    let displayName: String?
    let showCount: Int?
    let watchingCount: Int?
    let waitingCount: Int?
    let recommendingCount: Int?
    let nextCount: Int?
    let lastActivityAt: String?
    // Per-member secret for the /calendar/<slug>.ics feed. Only present when
    // the request carried a logged-in session.
    let calendarToken: String?

    enum CodingKeys: String, CodingKey {
        case slug, name
        case firstName = "first_name"
        case displayName = "display_name"
        case showCount = "show_count"
        case watchingCount = "watching_count"
        case waitingCount = "waiting_count"
        case recommendingCount = "recommending_count"
        case nextCount = "next_count"
        case lastActivityAt = "last_activity_at"
        case calendarToken = "calendar_token"
    }

    // Encoding only happens when the offline cache writes us to disk, so it
    // deliberately drops the calendar token: it's a per-member secret that
    // grants the whole .ics feed, and it has no business sitting in a cache
    // file. Decoding still reads it, so the live session keeps its Subscribe
    // row.
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(slug, forKey: .slug)
        try c.encode(name, forKey: .name)
        try c.encodeIfPresent(firstName, forKey: .firstName)
        try c.encodeIfPresent(displayName, forKey: .displayName)
        try c.encodeIfPresent(showCount, forKey: .showCount)
        try c.encodeIfPresent(watchingCount, forKey: .watchingCount)
        try c.encodeIfPresent(waitingCount, forKey: .waitingCount)
        try c.encodeIfPresent(recommendingCount, forKey: .recommendingCount)
        try c.encodeIfPresent(nextCount, forKey: .nextCount)
        try c.encodeIfPresent(lastActivityAt, forKey: .lastActivityAt)
    }

    var label: String { displayName ?? firstName ?? name }

    // A couple's label ("Jane & Joe", "Patrick and Ali") is a plural subject,
    // so empty-state copy uses "aren't/haven't" instead of "isn't/hasn't".
    var labelIsPlural: Bool {
        let l = label.lowercased()
        return l.contains(" & ") || l.contains(" and ")
    }

    // "Most active" = engaged lists: Watching + Next Up + Loved.
    var activeCount: Int {
        (watchingCount ?? 0) + (nextCount ?? 0) + (recommendingCount ?? 0)
    }
}

struct MembersResponse: Codable { let members: [Member] }

// One row from /api/shows/all — every active show across all members, used by
// cross-library search. Carries member attribution + cast so results can read
// "on Watching · William" and be filtered by actor.
struct AllShow: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let network: String?
    let networkUrl: String?
    let rating: String?
    let movie: Int?
    let fullSeries: Int?
    let list: String
    let memberSlug: String
    let genres: String?
    let memberName: String?
    let memberFirstName: String?
    let actors: String?
    let posterUrl: String?
    // The TMDB entry, so "who else has this?" can tell same-titled shows
    // apart. Optional: an older server doesn't send it.
    let tmdbId: Int?

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, movie, list, genres, actors
        case networkUrl = "network_url"
        case fullSeries = "full_series"
        case memberSlug = "member_slug"
        case memberName = "member_name"
        case memberFirstName = "member_first_name"
        case posterUrl = "poster_url"
        case tmdbId = "tmdb_id"
    }

    var isMovie: Bool { (movie ?? 0) == 1 }
    var isFullSeries: Bool { (fullSeries ?? 0) == 1 }
    var listLabel: String { ShowList(rawValue: list)?.title ?? list.capitalized }
    var ownerLabel: String {
        if let f = memberFirstName, !f.isEmpty { return f }
        if let n = memberName, let first = n.split(separator: " ").first { return String(first) }
        return memberSlug
    }
    var genreList: [String] {
        (genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
    // Flattened actor names for substring matching, mirroring the web's
    // actorNamesText(): the `actors` column is a JSON array of {name,imdb_id}.
    var actorNamesText: String {
        guard let actors, let data = actors.data(using: .utf8),
              let arr = try? JSONDecoder().decode([Actor].self, from: data) else { return "" }
        return arr.map { $0.name }.joined(separator: " ")
    }
}

struct AllShowsResponse: Codable { let shows: [AllShow] }

// /api/title-search result — the type-ahead pick while adding/suggesting a
// show. Picking one pins the exact TMDB entry so enrichment can't mismatch.
struct TitleHit: Codable, Identifiable, Hashable {
    let tmdbId: Int
    let mediaType: String
    let title: String
    let year: String?
    let posterUrl: String?

    enum CodingKeys: String, CodingKey {
        case title, year
        case tmdbId = "tmdb_id"
        case mediaType = "media_type"
        case posterUrl = "poster_url"
    }

    var id: String { "\(mediaType)-\(tmdbId)" }
    var isMovie: Bool { mediaType == "movie" }
    var metaText: String {
        [year, isMovie ? "Movie" : "TV series"].compactMap { $0 }.joined(separator: " · ")
    }
}

struct TitleSearchResponse: Codable { let results: [TitleHit] }

struct PopularShow: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let network: String?
    let networkUrl: String?
    let rating: String?
    let genres: String?
    let members: [String]?
    let posterUrl: String?
    // /api/popular returns `movie`; the shared row shows the "(Movie)" tag
    // from it, same as every other list. (The endpoint groups by title and
    // carries no season data, so Trending rows have no premiere line — on
    // the web either.)
    let movie: Int?

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, genres, members, movie
        case networkUrl = "network_url"
        case posterUrl = "poster_url"
    }
}

struct PopularResponse: Codable { let shows: [PopularShow] }

// One row of the Favorite Actors page: someone who recurs across the member's
// Watching / Awaiting / Loved lists, with the titles that put them there.
//
// Derived, never picked — there is no favourite flag in the schema. The signal
// is already in the library, and a second list to curate would only decay.
struct FavoriteActor: Codable, Identifiable, Hashable {
    let name: String
    let imdbId: String?
    let tmdbPersonId: Int?
    let showCount: Int
    let shows: [String]
    // The member's own copies behind the count — enough to draw the standard
    // show row and push the show card. Optional so a payload without it (or a
    // cached older one) still decodes; the view falls back to bare titles.
    let showCards: [FavoriteActorShow]?

    // The server groups on tmdb_person_id when TMDB supplied one and the
    // lowercased name otherwise; the row identity has to match that, or two
    // credits for the same person collide in the ForEach.
    var id: String { tmdbPersonId.map(String.init) ?? name.lowercased() }

    // Nil for a credit that predates actor IMDB ids — the row still renders,
    // it just isn't a link. Better than a link that 404s.
    var imdbURL: URL? {
        guard let imdbId, !imdbId.isEmpty else { return nil }
        return URL(string: "https://www.imdb.com/name/\(imdbId)/")
    }

    enum CodingKeys: String, CodingKey {
        case name, shows
        case imdbId = "imdb_id"
        case tmdbPersonId = "tmdb_person_id"
        case showCount = "show_count"
        case showCards = "show_cards"
    }
}

// One of those copies: the id opens the show card, the rest is what ShowRow
// needs to look like every other show row in the app.
struct FavoriteActorShow: Codable, Identifiable, Hashable {
    let id: Int
    let title: String
    let network: String?
    let rating: String?
    let posterUrl: String?
    let movie: Int?
    // Archived copies count once rated 8+, and the member's own overall
    // rating is what weighed the title in. Optional so an older cached
    // payload still decodes.
    let archived: Int?
    let myRating: Int?

    var isArchived: Bool { (archived ?? 0) == 1 }

    enum CodingKeys: String, CodingKey {
        case id, title, network, rating, movie, archived
        case posterUrl = "poster_url"
        case myRating = "my_rating"
    }
}

struct FavoriteActorsResponse: Codable {
    let actors: [FavoriteActor]
    // How many titles the member has rated, against the goal below which the
    // screen offers Rate My Shows. Optional for older cached payloads.
    let ratedCount: Int?
    let ratingGoal: Int?
    let needsRatings: Bool?

    enum CodingKeys: String, CodingKey {
        case actors
        case ratedCount = "rated_count"
        case ratingGoal = "rating_goal"
        case needsRatings = "needs_ratings"
    }
}

// Auth check response.
struct AuthCheckResponse: Codable {
    let authenticated: Bool
    let email: String?
    let member: String?
    let isAdmin: Bool?

    enum CodingKeys: String, CodingKey {
        case authenticated, email, member
        case isAdmin = "is_admin"
    }
}

// /api/reporting — operator dashboard metrics.
struct Reporting: Codable {
    let generatedAt: String?
    let newShows: ReportWindow
    let editedShows: ReportWindow
    let archivedShows: ReportWindow
    let newMembers: ReportWindow
    // Rating activity: people who rated in the window, and the all-time
    // submitted/titles counts.
    let ratingMembers: ReportWindow?
    // Per-window, like the other activity counts — NOT a scalar. Decoding it
    // as an Int failed the whole payload, which is what "Couldn't load
    // reporting" was.
    let ratingsSubmitted: ReportWindow?
    let ratingsTitles: Int?
    let activeMembers: ActiveWindow
    let activeByPlatform: PlatformWindows?
    // Sessions minted per auth method (week/month/quarter), and how every
    // account was created. What decides whether an auth channel still earns
    // what it costs to run.
    let signinMethods: SigninMethodWindows?
    let enrolledVia: [String: Int]?
    // Calendar feed usage — nothing recorded it before migration 061, so this
    // is nil against an older server.
    let calendarUsage: CalendarUsage?
    // Who has connected an AI app through the MCP server — one row per
    // connection, newest first. Nil against an older server.
    let mcpConnections: [MCPConnection]?
    let totals: ReportTotals
    let membersLogin: LoginStats?
    let neverLoggedIn: [NeverLoggedInMember]?
    let topNetworks: [NetworkCount]
    let topShared: [SharedTitle]

    enum CodingKeys: String, CodingKey {
        case totals
        case generatedAt = "generated_at"
        case newShows = "new_shows"
        case editedShows = "edited_shows"
        case archivedShows = "archived_shows"
        case newMembers = "new_members"
        case ratingMembers = "rating_members"
        case ratingsSubmitted = "ratings_submitted"
        case ratingsTitles = "ratings_titles"
        case activeMembers = "active_members"
        case activeByPlatform = "active_by_platform"
        case signinMethods = "signin_methods"
        case enrolledVia = "enrolled_via"
        case calendarUsage = "calendar_usage"
        case mcpConnections = "mcp_connections"
        case membersLogin = "members_login"
        case neverLoggedIn = "never_logged_in"
        case topNetworks = "top_networks"
        case topShared = "top_shared"
    }
}

// A member who has never logged in since tracking began (migration 013).
// seedsOnly is true when nothing beyond the seeded rows has happened.
struct NeverLoggedInMember: Codable, Identifiable {
    let slug: String
    let name: String?
    let joined: String?
    let showCount: Int
    let seedsOnly: Bool

    var id: String { slug }

    enum CodingKeys: String, CodingKey {
        case slug, name, joined
        case showCount = "show_count"
        case seedsOnly = "seeds_only"
    }

    var displayName: String { name ?? slug }
    var libraryStatus: String {
        if !seedsOnly { return "Has activity" }
        return showCount > 0 ? "Seeds only" : "No shows"
    }
}

// Active sessions per client platform (ios / tvos / web-small / web-large),
// per window. Keyed by the platform string the server reports.
struct PlatformWindows: Codable {
    let day: [String: Int]
    let week: [String: Int]
    let month: [String: Int]
}

// Sign-ins by method over longer windows than the platform breakdown — a
// 30-day cookie means daily counts say almost nothing.
struct SigninMethodWindows: Codable {
    let week: [String: Int]
    let month: [String: Int]
    let quarter: [String: Int]
}

// Members whose feed a calendar client actually fetched, plus total fetches.
// One AI-app connection (an OAuth grant) on the Reporting screen. Every field
// but the person is optional so one odd row can't fail the whole report.
// Usage is the member's last 30 days and all time (the ledger is kept a
// year) across all their AI apps — it's keyed by member, not by app.
struct MCPConnection: Codable, Identifiable {
    let memberSlug: String
    let name: String?
    let app: String?
    let scope: String?
    let connectedAt: String?
    let lastUsedAt: String?
    let revokedAt: String?
    // How many grants the row combines — a reconnect or a second app each
    // mints one, and the server folds them into one row per member.
    let connections: Int?
    let calls30d: Int?
    let writes30d: Int?
    let callsAll: Int?
    let writesAll: Int?

    var id: String { "\(memberSlug)|\(app ?? "")|\(connectedAt ?? "")" }
    var canWrite: Bool { (scope ?? "").contains("write") }

    enum CodingKeys: String, CodingKey {
        case name, app, scope
        case memberSlug = "member_slug"
        case connectedAt = "connected_at"
        case lastUsedAt = "last_used_at"
        case revokedAt = "revoked_at"
        case connections
        case calls30d = "calls_30d"
        case writes30d = "writes_30d"
        case callsAll = "calls_all"
        case writesAll = "writes_all"
    }
}

struct CalendarUsage: Codable {
    let week: Int
    let month: Int
    let ever: Int
    let fetches: Int
}

struct LoginStats: Codable {
    let ever: Int?
    let never: Int?
}

struct ReportWindow: Codable {
    let day: Int
    let week: Int
    let month: Int
    let allTime: Int
    enum CodingKeys: String, CodingKey {
        case day, week, month
        case allTime = "all_time"
    }
}

struct ActiveWindow: Codable {
    let day: Int
    let week: Int
    let month: Int
}

struct ReportTotals: Codable {
    let members: Int
    let activeShows: Int
    let archivedShows: Int
    let watching: Int
    let waiting: Int
    let recommending: Int
    let next: Int
    enum CodingKeys: String, CodingKey {
        case members, watching, waiting, recommending, next
        case activeShows = "active_shows"
        case archivedShows = "archived_shows"
    }
}

struct NetworkCount: Codable, Identifiable {
    let network: String
    let cnt: Int
    var id: String { network }
}

struct SharedTitle: Codable, Identifiable {
    let title: String
    let members: Int
    var id: String { title }
}

// /api/admin-url-cleanup — queue of titles missing a real network URL.
struct UrlQueueItem: Codable, Identifiable {
    let id: Int
    let title: String
    let network: String?
    let networkUrl: String?
    let memberCount: Int?
    let members: String?

    enum CodingKeys: String, CodingKey {
        case id, title, network, members
        case networkUrl = "network_url"
        case memberCount = "member_count"
    }
}

struct UrlCleanupResponse: Codable {
    let shows: [UrlQueueItem]
    let networks: [String]
    // Rows whose URL points at a different service than the stored network.
    // (The conflict and missing-poster queues left in 2026-10.)
    let mismatches: [UrlMismatch]?
}

// A row whose URL domain disagrees with its stored network. Operator chooses
// which side wins. POST action: fix_mismatch { id, keep: "url" | "network" }.
struct UrlMismatch: Codable, Identifiable {
    let id: Int
    let title: String
    let network: String
    let networkUrl: String
    let urlNetwork: String
    let member: String

    enum CodingKeys: String, CodingKey {
        case id, title, network, member
        case networkUrl = "network_url"
        case urlNetwork = "url_network"
    }
}

// MARK: - Subscription Audit (/api/subscriptions)

struct SubscriptionAudit: Codable {
    let member: String
    let today: String
    let services: [SubscriptionService]
    let totals: SubscriptionTotals
    // Household members pooled into this audit (nil/empty = just me).
    let household: [HouseholdMember]?
}

// A club member the audit can pool in (slug + first-name display label).
struct HouseholdMember: Codable, Identifiable {
    let slug: String
    let name: String
    var id: String { slug }
}

// A household invite link (POST /api/household/invite), 7-day expiry.
struct HouseholdInvite: Codable {
    let code: String
    let url: String
    let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case code, url
        case expiresAt = "expires_at"
    }
}

// Roster + current selection for the household picker (GET /api/household).
struct HouseholdInfo: Codable {
    let household: [String]
    let members: [HouseholdMember]
}

struct SubscriptionTotals: Codable {
    let serviceCount: Int
    let monthlySpendCents: Int
    let potentialSavingsCents: Int

    enum CodingKeys: String, CodingKey {
        case serviceCount = "service_count"
        case monthlySpendCents = "monthly_spend_cents"
        case potentialSavingsCents = "potential_savings_cents"
    }
}

struct SubscriptionService: Codable, Identifiable {
    let network: String
    let isManual: Bool
    let counts: SubscriptionCounts
    let shows: [SubscriptionShow]
    let verdict: String                      // keep | pause | pause_tba | start | cancel | manual
    let suggestedResubscribeDate: String?
    let status: String?                      // subscribed | paused | cancelled | nil (untouched)
    let monthlyPriceCents: Int?
    let resubscribeDate: String?
    var id: String { network }

    enum CodingKeys: String, CodingKey {
        case network, counts, shows, verdict, status
        case isManual = "is_manual"
        case suggestedResubscribeDate = "suggested_resubscribe_date"
        case monthlyPriceCents = "monthly_price_cents"
        case resubscribeDate = "resubscribe_date"
    }

    var effectiveStatus: String { status ?? "subscribed" }
}

struct SubscriptionCounts: Codable {
    let watching: Int
    let waiting: Int
    let recommending: Int
    let next: Int
}

struct SubscriptionShow: Codable, Identifiable {
    let title: String
    let list: String
    let nextSeasonDate: String?
    let fullSeries: Int?
    // Who in the household has this title, and what list it's on for them.
    // Sent only when the audit pools a real household — nil for a solo audit,
    // where every show is yours and naming a viewer says nothing.
    let viewers: [SubscriptionViewer]?
    var id: String { title }

    enum CodingKeys: String, CodingKey {
        case title, list, viewers
        case nextSeasonDate = "next_season_date"
        case fullSeries = "full_series"
    }

    // Household members actively watching this title ("You" sorts first).
    var watchers: [SubscriptionViewer] { (viewers ?? []).filter { $0.list == "watching" } }
}

// One person behind a pooled show. `name` is their first name, or "You".
struct SubscriptionViewer: Codable, Identifiable {
    let slug: String
    let name: String
    let list: String
    var id: String { slug }
}

// MARK: - Vibe (/api/vibe)

struct VibeResponse: Codable {
    let members: [VibeMemberRef]
    let member: VibeMember?
}

struct VibeMemberRef: Codable, Identifiable, Hashable {
    let slug: String
    let name: String
    let activeCount: Int?
    var id: String { slug }

    enum CodingKeys: String, CodingKey {
        case slug, name
        case activeCount = "active_count"
    }
}

struct VibeMember: Codable {
    let slug: String
    let name: String?
    // State flags — only one branch is populated per response.
    let excluded: Bool?
    let isSeedOnly: Bool?
    let noFingerprint: Bool?
    let activeCount: Int?
    let scoredCount: Int?
    // Full fingerprint (present only when the member has a real one).
    let cluster: VibeCluster?
    let displayTraits: [String: Int]?
    let balance: VibeBalance?
    let alignedPicks: [VibePick]?
    let outlierPicks: [VibePick]?

    enum CodingKeys: String, CodingKey {
        case slug, name, excluded, cluster, balance
        case isSeedOnly = "is_seed_only"
        case noFingerprint = "no_fingerprint"
        case activeCount = "active_count"
        case scoredCount = "scored_count"
        case displayTraits = "display_traits"
        case alignedPicks = "aligned_picks"
        case outlierPicks = "outlier_picks"
    }
}

struct VibeCluster: Codable {
    let id: String
    let name: String
    let tagline: String
    let similarity: Double
    let blend: [VibeBlendItem]
}

struct VibeBlendItem: Codable, Identifiable {
    let id: String
    let name: String
    let similarity: Double
}

struct VibeBalance: Codable {
    let range: Int
    let warmthDarknessBalance: Int
    let warmthDarknessLabel: String

    enum CodingKeys: String, CodingKey {
        case range
        case warmthDarknessBalance = "warmth_darkness_balance"
        case warmthDarknessLabel = "warmth_darkness_label"
    }
}

struct VibePick: Codable, Identifiable {
    let title: String
    let titleLower: String?
    let list: String?
    let network: String?
    let networkUrl: String?
    let rating: String?
    let genres: String?
    let actors: [String]?
    // A representative live copy of the title, attached by enrichPick() in
    // functions/api/vibe.js so a pick renders as an ordinary show card and
    // opens the same detail screen as everywhere else. Absent only when no
    // unarchived copy of the title exists anywhere in the club.
    let showId: Int?
    let posterUrl: String?
    let movie: Int?
    let seasonsReleased: Int?
    let fullSeries: Int?
    let nextSeasonDate: String?
    // The pick's TMDB entry, so adding it adds that show and not another one
    // that shares its title. Nil from a server that predates it.
    let tmdbId: Int?
    let tmdbType: String?
    var id: String { title }

    enum CodingKeys: String, CodingKey {
        case title, list, network, rating, genres, actors, movie
        case showId = "id"
        case titleLower = "title_lower"
        case tmdbId = "tmdb_id"
        case tmdbType = "tmdb_type"
        case networkUrl = "network_url"
        case posterUrl = "poster_url"
        case seasonsReleased = "seasons_released"
        case fullSeries = "full_series"
        case nextSeasonDate = "next_season_date"
    }
}

// Display order for the ten vibe trait signals, matching the web. The API
// returns display_traits as an unordered object; we render in this order.
let VIBE_TRAIT_ORDER: [String] = [
    "Warmth", "Empathy", "Complexity", "Cynicism risk", "Power orientation",
    "Curiosity", "Healing & growth", "Chaos tolerance",
    "Humor (warm vs cruel)", "Optimism",
]

// The four signals the screen leads with; the rest sit behind "Show all
// traits". Same set, order and copy as vibe.html — a trait that means one
// thing on the web and another in the app is worse than no explanation.
let VIBE_TOP_TRAITS: [String] = ["Complexity", "Warmth", "Curiosity", "Empathy"]

let VIBE_TRAIT_EXPLAIN: [String: String] = [
    "Warmth": "How much affection, found-family, and comfort your shows lean into.",
    "Empathy": "How much your taste rewards understanding other people's inner lives.",
    "Complexity": "Moral ambiguity, dense plotting, and prestige-drama feel.",
    "Cynicism risk": "Distrustful, mean-humored, or nihilistic energy.",
    "Power orientation": "Interest in hierarchies, status games, manipulation.",
    "Curiosity": "Ideas, puzzles, intellectual depth, learning.",
    "Healing & growth": "Characters working through wounds and finding redemption.",
    "Chaos tolerance": "Comfort with unpredictable, anarchic, big-swing storytelling.",
    "Humor (warm vs cruel)": "0 = humor at others' expense, 100 = humor that's kind.",
    "Optimism": "Hopeful, life-affirming worldview vs. bleak.",
]

let VIBE_BLEND_EXPLAIN: [String: String] = [
    "Curious Omnivore": "Watches broadly across prestige, comedy, and comfort.",
    "Warm Comfort Viewer": "Found-family, soft-blanket shows; low on darkness.",
    "Prestige Drama Loyalist": "Slow burns, ambitious craft, morally ambiguous leads.",
    "Dark Complexity Seeker": "Heavy themes with empathy underneath, not nihilism.",
    "Satirical Cynic": "Sharp irony at the expense of the powerful.",
    "Power Game Watcher": "Status, scheming, who-controls-whom.",
    "Chaos Goblin": "Unhinged, absurd, emotionally chaotic. Big swings.",
    "Empathy & Healing Viewer": "Emotional repair, redemption, chosen family.",
]

// MARK: - Admin: member contacts (/api/admin-member-emails)

struct AdminMembersResponse: Codable { let members: [AdminMember] }

struct AdminMember: Codable, Identifiable {
    let slug: String
    let name: String?
    let firstName: String?
    let lastInitial: String?
    let lastName: String?
    let emails: [String]
    let phones: [String]
    let lastLogin: String?
    // How they last got in: apple | google | email | sms | demo.
    // nil for a member who hasn't logged in since migration 059.
    let lastLoginMethod: String?
    let lastActivityAt: String?
    let activity30d: MemberActivity?
    // Current per-list totals, active and non-seed — the same terms as
    // showCount, so the four sum to it. Absent on an older server.
    let listCounts: MemberActivity?
    // When the account was created (members.created_at). Absent on an older
    // server; nil for the hand-seeded rows that predate the column.
    let joinedAt: String?
    // Non-seed active shows — the duplicates panel ranks the default keeper
    // by library size.
    let showCount: Int?
    // Non-seed archived shows. Archiving is member-initiated, so this is
    // engagement the active lists don't show.
    let archivedCount: Int?
    // Status flags (optional so decoding survives an older server).
    let isAdmin: Bool?
    let disabled: Bool?
    let enrolledVia: String?
    // Every platform this member has ever used the app from (migration 047);
    // absent on an older server. Values match X-Client-Platform: iphone,
    // ipad, mac, watchos, tvos, web-small, web-large.
    let platforms: [String]?
    var id: String { slug }

    enum CodingKeys: String, CodingKey {
        case slug, name, emails, phones, disabled, platforms
        case firstName = "first_name"
        case lastInitial = "last_initial"
        case lastName = "last_name"
        case lastLogin = "last_login"
        case lastLoginMethod = "last_login_method"
        case lastActivityAt = "last_activity_at"
        case activity30d = "activity_30d"
        case listCounts = "list_counts"
        case joinedAt = "joined_at"
        case showCount = "show_count"
        case archivedCount = "archived_count"
        case isAdmin = "is_admin"
        case enrolledVia = "enrolled_via"
    }

    // The person's actual name, from the clean first_name/last_name columns.
    // members.name is the legacy "…'s Shows" display blob — hand-entered and
    // inconsistent, so it's only a last-resort fallback here.
    var personName: String {
        let full = [firstName, lastName].compactMap { $0 }.joined(separator: " ")
        return full.trimmingCharacters(in: .whitespaces).isEmpty ? (name ?? slug) : full
    }

    // The roster shape, so an admin screen can open this person's member page
    // without a second trip to /api/members. Synthesized rather than looked up
    // on purpose: a just-signed-up member is in the admin list before anything
    // else, and the roster is the one place they might not be yet.
    //
    // Only slug and label survive the trip — MemberView reads nothing else off
    // Member, and the counts it would find here are the admin list's
    // non-seed totals, which aren't the same number the roster reports.
    var asMember: Member {
        Member(slug: slug, name: name ?? personName, firstName: firstName,
               displayName: nil, showCount: nil, watchingCount: nil,
               waitingCount: nil, recommendingCount: nil, nextCount: nil,
               lastActivityAt: lastActivityAt, calendarToken: nil)
    }
}

struct MemberActivity: Codable {
    let watching: Int
    let waiting: Int
    let recommending: Int
    let next: Int
}

// /api/admin-member-groups — which private groups a member is in, and who else
// is in each, for the Groups section of the admin member screen.
//
// Deliberately not ShowPickerCore.Group: that model is what a member sees of
// their *own* groups and carries is_creator meaning "can I delete this". This
// one is an operator's read of somebody else's groups, where the creator is a
// fact about another person, not a permission of the reader's.
struct AdminMemberGroupsResponse: Codable {
    let member: String
    let groups: [AdminGroup]
}

struct AdminGroup: Codable, Identifiable, Hashable {
    let id: Int
    let name: String
    let creatorSlug: String?
    let createdAt: String?
    let members: [AdminGroupMember]

    enum CodingKeys: String, CodingKey {
        case id, name, members
        case creatorSlug = "creator_slug"
        case createdAt = "created_at"
    }

    // The roster's own length, never the server's member_count. The section
    // row and the screen behind it are then the same number by construction —
    // a count that can disagree with the list it opens is worse than no count.
    var memberCount: Int { members.count }
}

struct AdminGroupMember: Codable, Identifiable, Hashable {
    let slug: String
    let name: String
    let isCreator: Int?
    let disabled: Int?

    var id: String { slug }
    var isTheCreator: Bool { (isCreator ?? 0) == 1 }
    var isDisabled: Bool { (disabled ?? 0) == 1 }

    enum CodingKeys: String, CodingKey {
        case slug, name, disabled
        case isCreator = "is_creator"
    }
}

// /api/activity — recent adds, newest first, club-wide or (?member=) scoped to
// one person. `text` is the server's rendered line; the fields beside it exist
// so a client can lay the same event out its own way.
struct ActivityResponse: Codable { let feed: [ActivityItem] }

struct ActivityItem: Codable, Identifiable {
    let text: String
    let time: String?
    // A collapsed bulk add carries the first title and how many there were.
    let title: String?
    let count: Int?
    let list: String?
    let listLabel: String?
    let memberSlug: String?
    let memberFirstName: String?

    // Time alone isn't unique across a bulk add that spans two lists, so the
    // list is part of the identity.
    var id: String { "\(time ?? "")|\(list ?? "")|\(title ?? "")" }

    var isBatch: Bool { (count ?? 1) > 1 }

    enum CodingKeys: String, CodingKey {
        case text, time, title, count, list
        case listLabel = "list_label"
        case memberSlug = "member_slug"
        case memberFirstName = "member_first_name"
    }
}

// MARK: - Admin: vibe trait scoring (/api/admin-vibe-fill)

struct VibeFillStatus: Codable {
    let rescoreActive: Bool
    let rescoreStartedAt: String?
    let fillRemaining: Int
    let rescoreRemaining: Int

    enum CodingKeys: String, CodingKey {
        case rescoreActive = "rescore_active"
        case rescoreStartedAt = "rescore_started_at"
        case fillRemaining = "fill_remaining"
        case rescoreRemaining = "rescore_remaining"
    }
}

struct VibeFillResult: Codable {
    let processed: Int?
    let unknown: Int?
    let errors: Int?
    let remaining: Int?
    let mode: String?
    let ok: Bool?
    let error: String?
    // Per-title outcomes for the batch — what actually happened to each show,
    // which a batch summary can't tell you.
    let results: [VibeFillRow]?
}

struct VibeFillRow: Codable, Identifiable {
    let title: String
    let status: String          // ok | unknown | error
    let error: String?
    var id: String { title }

    var line: String {
        var s = "\(title): \(status)"
        if let e = error, !e.isEmpty { s += " (\(e))" }
        return s
    }
}

// Generic admin action result (save URL / fix title).

struct AdminActionResult: Codable {
    let ok: Bool?
    let updated: Int?
    let error: String?
    let newTitle: String?

    enum CodingKeys: String, CodingKey {
        case ok, updated, error
        case newTitle = "new_title"
    }
}

// Login response. `needsName` (self-enroll only) means the code/identity
// checked out for an unknown email or Apple ID: collect a name and finish via
// /auth/enroll (email) or a second /auth/apple call (Apple).
struct LoginResponse: Codable {
    let success: Bool?
    let slug: String?
    let needsName: Bool?
    let error: String?

    enum CodingKeys: String, CodingKey {
        case success, slug, error
        case needsName = "needs_name"
    }
}

// MARK: Passkeys
//
// The WebAuthn options the server hands back. Only the fields the native
// client actually uses are decoded — AuthenticationServices builds the rest
// of the request itself, so pubKeyCredParams / authenticatorSelection (which
// the web would need) are ignored here on purpose.

// /auth/passkey-register-begin
struct PasskeyRegistrationOptions: Decodable {
    let challenge: String
    let user: PasskeyUser

    struct PasskeyUser: Decodable {
        /// base64url member slug — the WebAuthn user handle.
        let id: String
        let name: String
        let displayName: String
    }
}

// /auth/passkey-begin. No credential list: the passkeys are discoverable, so
// the device already knows which ones it holds for showpicker.club.
struct PasskeyAssertionOptions: Decodable {
    let challenge: String
    let rpId: String
}

// One registered passkey, as /api/passkeys lists them.
struct Passkey: Decodable, Identifiable {
    let credentialId: String
    let label: String?
    let createdAt: String?
    let lastUsedAt: String?

    var id: String { credentialId }

    enum CodingKeys: String, CodingKey {
        case credentialId = "credential_id"
        case label
        case createdAt = "created_at"
        case lastUsedAt = "last_used_at"
    }
}

// One AI app connected to this account through the MCP server, as
// /api/connected-apps lists them. `host` is where the app lives (claude.ai,
// "an app on this computer"), which is what tells two entries both called
// "Claude" apart — the name is whatever the app called itself.
struct ConnectedApp: Decodable, Identifiable {
    let id: Int
    let name: String
    let host: String?
    let canWrite: Bool
    let connectedAt: String?
    let lastUsedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, name, host
        case canWrite = "can_write"
        case connectedAt = "connected_at"
        case lastUsedAt = "last_used_at"
    }
}

// /api/account-delete response — `sent` for the send-a-code step, `deleted`
// for the confirm step; `error` carries no_email / admin_must_demote_first /
// invalid / rate_limited on failure.
struct AccountDeleteResponse: Codable {
    let sent: Bool?
    let deleted: Bool?
    let error: String?
}

// The four lists, in display order.

// The canonical network list used to live here as a `[String]` literal, which
// meant a network added on the server reached a member only when they installed
// a new App Store build. It now comes from GET /api/networks — see
// NetworkCatalogStore (fetch + cache) and ShowPickerCore.NetworkCatalog (the
// model, the section grouping, and the bundled seed for a first launch with no
// signal). Don't reintroduce a literal here.

// MARK: - List import (paste a list, /api/import/*)

// One title the parser pulled out of a pasted list, on its way to the review
// screen. Mutable because the review screen is where the member fixes what the
// parse got wrong — the list picker and the include toggle both write here —
// and Encodable because the same rows go straight back to /api/import/commit.
struct ImportItem: Codable, Identifiable {
    // Client-side only: rows aren't persisted yet, so there's no server id to
    // key the review list on.
    let id = UUID()

    var title: String
    // What the member actually typed, when TMDB corrected it. The review row
    // shows this so a silent "correction" of a title we matched wrong is
    // visible rather than buried.
    var rawTitle: String?
    var list: String
    var notes: String?
    var network: String?
    var recommendedBy: String?
    var watchingWith: String?
    var movie: Int?
    var year: Int?
    var tmdbId: Int?
    var tmdbType: String?
    var posterUrl: String?
    // TMDB had no match. The row is still offered — TMDB misses real things —
    // but it goes in without artwork or an id.
    var matched: Bool?
    // Already on one of the member's lists. Set means the row is excluded by
    // default and the review screen says why.
    var existingList: String?
    var existingArchived: Bool?

    enum CodingKeys: String, CodingKey {
        case title, list, notes, network, movie, year, matched
        case rawTitle = "raw_title"
        case recommendedBy = "recommended_by"
        case watchingWith = "watching_with"
        case tmdbId = "tmdb_id"
        case tmdbType = "tmdb_type"
        case posterUrl = "poster_url"
        case existingList = "existing_list"
        case existingArchived = "existing_archived"
    }

    var showList: ShowList { ShowList(rawValue: list) ?? .watching }
    var isDuplicate: Bool { existingList != nil || existingArchived == true }
    var isMovie: Bool { (movie ?? 0) == 1 }
}

struct ImportParseResponse: Codable {
    let items: [ImportItem]
    let nextCursor: Int?
    let section: String?
    let totalChars: Int?

    enum CodingKeys: String, CodingKey {
        case items, section
        case nextCursor = "next_cursor"
        case totalChars = "total_chars"
    }
}

struct ImportCommitResult: Codable {
    let added: Int
    let skipped: Int
    let titles: [String]
    let skippedTitles: [String]
    // Titles TMDB couldn't identify, set aside rather than added: every show
    // is a TMDB entry. Absent from a server that predates it.
    let unmatchedTitles: [String]?
    // On the final call: whether the list of unmatched titles was emailed.
    let emailed: Bool?

    enum CodingKeys: String, CodingKey {
        case added, skipped, titles, emailed
        case skippedTitles = "skipped_titles"
        case unmatchedTitles = "unmatched_titles"
    }
}
