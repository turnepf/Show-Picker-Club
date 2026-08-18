import Foundation
import UIKit

// Async client for showpicker.club. Read endpoints are unauthed; write
// endpoints rely on the session cookie set by /auth/login — URLSession's
// default config persists cookies via HTTPCookieStorage automatically,
// so we don't manage cookies by hand.

enum API {
    static let baseString = "https://showpicker.club"

    // Platform usage tracking (Manage Members badges): Mac Catalyst first —
    // UIDevice still reports .phone/.pad under Catalyst — then iPad vs
    // iPhone by interface idiom.
    static let currentPlatform: String = {
        if ProcessInfo.processInfo.isMacCatalystApp { return "mac" }
        return UIDevice.current.userInterfaceIdiom == .pad ? "ipad" : "iphone"
    }()

    // Error payload the JSON senders decode from a non-2xx body. Declared at
    // the type level (not inside the generic sendJSON) because Swift forbids
    // nesting a type in a generic function.
    private struct ErrBody: Decodable {
        let error: String?
        let id: Int?
        let list: String?
        let title: String?
    }

    // sendJSON drops Swift-nil body values so the JSON omits them, and the
    // update endpoint keeps a field whose key is absent (only an explicit JSON
    // null clears it). So a cleared editable field (e.g. an emptied note) would
    // be dropped, not cleared. Wrap it in NSNull() to send an explicit null.
    private static func jsonNullable(_ s: String?) -> Any {
        if let s { return s }
        return NSNull()
    }

    enum APIError: Error {
        case badURL, badResponse(Int), badBody
        // Non-2xx whose JSON body decoded: the server's actual rejection
        // (exists_active, exists_archived, rate_limited, Unauthorized, …),
        // so views can explain the real reason instead of guessing from
        // the status code.
        case rejected(ServerRejection)

        var status: Int? {
            switch self {
            case .badResponse(let s): return s
            case .rejected(let r): return r.status
            default: return nil
            }
        }
    }

    struct ServerRejection {
        let status: Int
        let code: String     // the body's "error" string
        let id: Int?         // exists_archived: the archived row to restore
        let list: String?    // exists_active: which list already has it
        let title: String?   // canonical title the server deduped against
    }

    // Short, honest failure line for a member-visible error: names an expired
    // session or being offline when that's the cause, and stays generic
    // otherwise instead of inventing one.
    static func failureLine(_ error: Error, action: String) -> String {
        if let e = error as? APIError, e.status == 401 {
            return "You're logged out — sign in again from Home."
        }
        if isOffline(error) {
            return "You're offline — couldn't \(action)."
        }
        return "Couldn't \(action). Try again."
    }

    // True for the URLError codes that mean "no usable network" rather than a
    // real server rejection. We queue writes / serve cache for these, and
    // propagate everything else (4xx/5xx, decode failures) as before.
    static func isOffline(_ error: Error) -> Bool {
        guard let e = error as? URLError else { return false }
        switch e.code {
        case .notConnectedToInternet, .networkConnectionLost, .timedOut,
             .cannotConnectToHost, .cannotFindHost, .dnsLookupFailed,
             .dataNotAllowed, .internationalRoamingOff:
            return true
        default:
            return false
        }
    }

    // MARK: GET helpers

    private static func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadRevalidatingCacheData
        // Platform usage tracking: /auth/check stamps this onto the session.
        req.setValue(currentPlatform, forHTTPHeaderField: "X-Client-Platform")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.badResponse(-1) }
        guard (200..<300).contains(http.statusCode) else { throw APIError.badResponse(http.statusCode) }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // GET that mirrors each success to the offline cache and, when the device
    // is offline, replays the last good copy instead of throwing.
    private static func getCached<T: Codable>(_ path: String, cacheKey: String) async throws -> T {
        do {
            let value: T = try await get(path)
            OfflineCache.save(value, for: cacheKey)
            return value
        } catch {
            if isOffline(error), let cached = OfflineCache.load(T.self, for: cacheKey) {
                return cached
            }
            throw error
        }
    }

    // MARK: Reads

    // Plain-text export of the signed-in member's own lists (/api/export).
    // Returns the raw text body; the caller writes it to a file and hands it
    // to the system share sheet. Session cookie authenticates, same as every
    // other authed call.
    static func exportText() async throws -> String {
        guard let url = URL(string: baseString + "/api/export") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue(currentPlatform, forHTTPHeaderField: "X-Client-Platform")
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError.badResponse(-1) }
        guard (200..<300).contains(http.statusCode) else { throw APIError.badResponse(http.statusCode) }
        return String(data: data, encoding: .utf8) ?? ""
    }

    static func members() async throws -> [Member] {
        let r: MembersResponse = try await getCached("/api/members", cacheKey: "members")
        return r.members
    }

    // The people you can name in "Watching with" — everyone you share a
    // private group with. Session-gated and self-scoped; a member in no group
    // gets an empty list, which is what hides the picker entirely.
    static func groupMates() async throws -> [GroupMate] {
        struct Wrapper: Decodable { let members: [GroupMate] }
        let r: Wrapper = try await get("/api/group-members")
        return r.members
    }

    // The network picker's contents. Public endpoint — no session — so a
    // launch before sign-in can still warm the list. NetworkCatalogStore owns
    // the caching and the fallback; this is just the fetch.
    static func networks() async throws -> NetworkCatalog {
        try await get("/api/networks")
    }

    // limit: nil takes the server default (10) — what Home draws on launch.
    // Passing a larger value is the "Show more" path, cached under its own key
    // so the expanded list can't be served from the ten-row snapshot or
    // overwrite it.
    static func popular(limit: Int? = nil) async throws -> [PopularShow] {
        let path = limit.map { "/api/popular?limit=\($0)" } ?? "/api/popular"
        let key = limit.map { "popular-\($0)" } ?? "popular"
        let r: PopularResponse = try await getCached(path, cacheKey: key)
        return r.shows
    }

    // Favourite actors, derived from the member's own Watching / Awaiting /
    // Loved lists. Owner-only on the server, so there's no member parameter.
    static func favoriteActors() async throws -> [FavoriteActor] {
        let r: FavoriteActorsResponse = try await getCached("/api/favorite-actors",
                                                           cacheKey: "favorite-actors")
        return r.actors
    }

    // Active shows for a member. Online: fetch and refresh the offline snapshot.
    // Offline: serve the snapshot (with any pending offline edits already
    // layered on) so browsing and optimistic edits both keep working.
    static func shows(member slug: String, includeArchived: Bool = false) async throws -> [Show] {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        var path = "/api/shows?member=\(enc)"
        if includeArchived { path += "&include_archived=1" }
        do {
            let r: ShowsResponse = try await get(path)
            if !includeArchived { await OfflineQueue.shared.replaceMember(slug, shows: r.shows) }
            return r.shows
        } catch {
            if isOffline(error) {
                return await OfflineQueue.shared.shows(for: slug, includeArchived: includeArchived)
            }
            throw error
        }
    }

    // Returns the show alongside its ratings summary (average/count always;
    // `mine`/`owner` depend on the session — see RatingsSummary). `ratings`
    // is nil until the show has a tmdb_id (not yet enriched).
    static func showDetail(id: Int) async throws -> ShowResponse {
        do {
            let r: ShowResponse = try await get("/api/shows/\(id)")
            OfflineCache.save(r, for: "show_\(id)")
            return r
        } catch {
            if isOffline(error) {
                if let cached = OfflineCache.load(ShowResponse.self, for: "show_\(id)") { return cached }
                if let local = await OfflineQueue.shared.cachedShow(id: id) {
                    return ShowResponse(show: local, ratings: nil)
                }
            }
            throw error
        }
    }

    // Rate my own copy of a show — overall (season nil) or a specific
    // season. Instant-save from the caller (no separate confirm step).
    // Online: returns the freshly recomputed summary so the view can
    // update without a refetch. Offline: queues the rating (replayed once
    // connectivity returns, same as move/archive/etc.) and returns nil —
    // callers should fold the tapped value into their local state
    // themselves (see RatingsSummary.withMine/withMineSeason) rather than
    // waiting on a summary that isn't coming yet.
    static func rateShow(id: Int, rating: Int, season: Int? = nil) async throws -> RatingsSummary? {
        do {
            return try await rateShowRemote(id: id, rating: rating, season: season)
        } catch {
            if isOffline(error) {
                await OfflineQueue.shared.enqueueRate(id: id, rating: rating, season: season)
                return nil
            }
            throw error
        }
    }

    static func rateShowRemote(id: Int, rating: Int, season: Int? = nil) async throws -> RatingsSummary? {
        let r: RatingResponse = try await putJSON("/api/shows/\(id)/rating", body: ["rating": rating, "season": season])
        return r.ratings
    }

    // Backing list for the "rate your backlog" bulk flow: every show the
    // member hasn't given an overall rating yet. Offline-cached like other
    // reads (keyed by member, same as showDetail keys by show id — this is
    // session-scoped server-side, so a flat cache key could otherwise leak
    // a stale list across members on a shared device). The bulk screen
    // further filters out anything with a pending offline rating (see
    // OfflineQueue.pendingRating) so an already-tapped show doesn't
    // reappear before it's actually synced.
    static func rateBacklog(member: String) async throws -> RateBacklogResponse {
        try await getCached("/api/rate-backlog", cacheKey: "rate_backlog_\(member)")
    }

    // Just the unrated count, for the "Rate my backlog" nav badge — the same
    // rows rateBacklog() returns, counted server-side so Home doesn't pull the
    // whole backlog (posters, titles, season counts) to render one integer.
    static func rateBacklogCount() async throws -> Int {
        let r: RateBacklogCountResponse = try await getCached(
            "/api/rate-backlog-count", cacheKey: "rate_backlog_count")
        return r.count
    }

    static func actors(showId: Int) async throws -> [Actor] {
        let r: ActorsResponse = try await getCached("/api/shows/\(showId)/actors", cacheKey: "actors_\(showId)")
        return r.actors
    }

    // Every active show across every member — backs cross-library search.
    static func allShows() async throws -> [AllShow] {
        let r: AllShowsResponse = try await getCached("/api/shows/all", cacheKey: "all_shows")
        return r.shows
    }

    static func checkAuth() async -> AuthCheckResponse {
        (try? await get("/auth/check")) ?? AuthCheckResponse(authenticated: false, email: nil, member: nil, isAdmin: nil)
    }

    // Operator-only dashboard metrics (gated server-side on the session).
    static func reporting() async throws -> Reporting {
        try await get("/api/reporting")
    }

    // Pending /join signup requests (operator only).
    static func signupRequests() async throws -> [SignupRequest] {
        let r: SignupRequestsResponse = try await get("/api/admin-signup-requests")
        return r.requests
    }

    // Approve or reject a signup request; decodes the body either way so the
    // caller can show the server's message (e.g. a phone clash on approve).
    static func actOnSignupRequest(id: Int, action: String, notes: String? = nil) async throws -> SignupActionResult {
        guard let url = URL(string: baseString + "/api/admin-signup-requests") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var body: [String: Any] = ["id": id, "action": action]
        if let n = notes { body["notes"] = n }
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(SignupActionResult.self, from: data)
    }

    // URL-cleanup queue: titles still on a placeholder network URL (operator).
    static func urlCleanupQueue() async throws -> UrlCleanupResponse {
        try await postDecoding("/api/admin-url-cleanup", body: ["action": "list"])
    }

    // Save a real deep link for a queued title (propagates to every copy).
    static func saveShowUrl(id: Int, network: String, url: String) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup",
                               body: ["action": "save", "id": id, "network": network, "network_url": url])
    }

    // Rename a wrong/typo'd title across all copies and re-enrich it (operator).
    // Optional network correction rides along: every copy moves to the chosen
    // service and wrong-service URLs are cleared for the next fill pass.
    static func fixShowTitle(id: Int, newTitle: String, network: String? = nil) async throws -> AdminActionResult {
        var body: [String: Any] = ["action": "fix_title", "id": id, "new_title": newTitle]
        if let n = network, !n.isEmpty { body["network"] = n }
        return try await postDecoding("/api/admin-url-cleanup", body: body)
    }

    // Re-run enrichment for one title as-is, optionally flipping its media
    // type — the fix for a title TMDB indexed as the opposite of what we
    // stored. Writes poster/logo/rating/cast onto every copy.
    static func reEnrichShow(id: Int, movie: Bool) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup",
                               body: ["action": "re_enrich", "id": id, "movie": movie ? 1 : 0])
    }

    // One background enrichment batch — posters, logos, seasons, dates. The
    // endpoint processes the least-recently-enriched rows, so calling it
    // repeatedly rotates through the library.
    @discardableResult
    static func enrich() async throws -> AdminActionResult {
        try await postDecoding("/api/enrich", body: [:])
    }

    // Bulk: give every row with a placeholder URL the real link a sibling copy
    // already has. Cheap, and clears most of the queue before any manual work.
    static func inheritNetworks() async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup", body: ["action": "inherit_networks"])
    }

    // Drop a title out of the URL queue for good — no good deep link exists.
    static func dismissUrlTitle(_ title: String) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup", body: ["action": "dismiss", "title": title])
    }

    // POST + decode the body regardless of HTTP status, so admin tools can show
    // the server's error message instead of a bare status code.
    private static func postDecoding<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, _) = try await URLSession.shared.data(for: req)
        return try JSONDecoder().decode(T.self, from: data)
    }

    // Resolve a conflict: set every active copy of a title to one network.
    static func resolveUrlConflict(title: String, network: String) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup",
                               body: ["action": "resolve_conflict", "title": title, "network": network])
    }

    // Fix a URL/network mismatch: keep "url" (adopt the URL's network) or
    // "network" (drop the URL so the next fill pass repicks one).
    static func fixUrlMismatch(id: Int, keep: String) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-url-cleanup",
                               body: ["action": "fix_mismatch", "id": id, "keep": keep])
    }

    // MARK: Subscription Audit (own session)

    static func subscriptions() async throws -> SubscriptionAudit {
        try await get("/api/subscriptions")
    }

    // Upsert one service's saved decision. Omitted fields are left untouched
    // server-side; `remove` deletes a manual service. Returns nothing useful.
    static func updateSubscription(network: String, status: String? = nil,
                                   monthlyPriceCents: Int? = nil, resubscribeDate: String?? = nil,
                                   isManual: Bool? = nil, remove: Bool = false) async throws {
        struct Ack: Decodable {}
        var body: [String: Any?] = ["network": network]
        if remove { body["remove"] = true }
        if let s = status { body["status"] = s }
        if let p = monthlyPriceCents { body["monthly_price_cents"] = p }
        // resubscribeDate is a double-optional: .some(nil) clears it, .none omits it.
        if let outer = resubscribeDate { body["resubscribe_date"] = outer ?? "" }
        if let m = isManual { body["is_manual"] = m ? 1 : 0 }
        let _: Ack = try await putJSON("/api/subscriptions", body: body)
    }

    // MARK: Household

    // The members whose shows are pooled into my subscription audit, plus the
    // roster to choose from (GET), and a save (PUT replaces the whole set).
    static func household() async throws -> HouseholdInfo {
        try await get("/api/household")
    }

    // Invite someone into your household by link, the same shape groups use —
    // you can't add a person to your household from a roster any more than
    // you can add them to a group.
    static func householdInvite() async throws -> HouseholdInvite {
        try await postJSON("/api/household/invite", body: [:])
    }

    @discardableResult
    static func joinHousehold(code: String) async throws -> Bool {
        struct Ack: Decodable { let ok: Bool? }
        let r: Ack = try await postJSON("/api/household/join", body: ["code": code])
        return r.ok ?? true
    }

    @discardableResult
    static func removeFromHousehold(slug: String) async throws -> Bool {
        struct Ack: Decodable { let ok: Bool? }
        let r: Ack = try await postJSON("/api/household/remove", body: ["member_slug": slug])
        return r.ok ?? true
    }

    @discardableResult
    static func saveHousehold(_ slugs: [String]) async throws -> Bool {
        struct Ack: Decodable {}
        let _: Ack = try await putJSON("/api/household", body: ["members": slugs])
        return true
    }

    // MARK: Vibe

    // Taste fingerprint for a member (any member; requires login). Pass nil to
    // get just the eligible-member list.
    static func vibe(member slug: String?) async throws -> VibeResponse {
        var path = "/api/vibe"
        if let slug, !slug.isEmpty {
            let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
            path += "?member=\(enc)"
        }
        return try await get(path)
    }

    // MARK: Admin: member contacts

    static func adminMembers() async throws -> [AdminMember] {
        let r: AdminMembersResponse = try await get("/api/admin-member-emails")
        return r.members
    }

    // One member's admin detail — what the member page's admin strip needs,
    // without pulling every member's emails and phones to draw one header.
    // nil when the slug isn't a member (rather than throwing, since the strip
    // is decoration and its absence shouldn't read as a failure).
    static func adminMember(slug: String) async throws -> AdminMember? {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        let r: AdminMembersResponse = try await get("/api/admin-member-emails?member=\(enc)")
        return r.members.first
    }

    // The private groups one member belongs to, each with its roster — the
    // Groups section of the admin member screen. Admin-only server-side (403
    // otherwise), and it answers with membership only: a group's shows are not
    // in the payload, and this doesn't join the caller to anything.
    static func adminMemberGroups(slug: String) async throws -> [AdminGroup] {
        let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? slug
        let r: AdminMemberGroupsResponse = try await get("/api/admin-member-groups?member=\(enc)")
        return r.groups
    }

    // Recent adds, newest first. Bulk adds arrive pre-collapsed into one
    // "added N shows to <list>" entry by the server.
    static func activity(member: String? = nil, limit: Int = 10) async throws -> [ActivityItem] {
        var path = "/api/activity?limit=\(limit)"
        if let member {
            let enc = member.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? member
            path += "&member=\(enc)"
        }
        let r: ActivityResponse = try await get(path)
        return r.feed
    }

    // Replace a member's email and/or phone set, and/or rename them (renames
    // keep the slug/URL). First/last name travel separately so a shared list
    // can carry a multi-word first name ("Paula & Brad") — a combined string
    // would get token-split server-side and lose the middle. Pass
    // comma/space-separated strings; an empty string clears that side.
    // Decodes the body either way so the caller can show validation errors.
    static func updateMemberContacts(slug: String, firstName: String? = nil, lastName: String? = nil,
                                     emails: String?, phones: String?) async throws -> AdminActionResult {
        var body: [String: Any] = ["slug": slug]
        if let f = firstName { body["first_name"] = f }
        if let l = lastName { body["last_name"] = l }
        if let e = emails { body["emails"] = e }
        if let p = phones { body["phones"] = p }
        return try await postDecoding("/api/admin-member-emails", body: body)
    }

    // Ban hammer: flips members.disabled; disabling also kills every session
    // the member holds, so the lockout is immediate.
    static func setMemberDisabled(slug: String, disabled: Bool) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-member-disable",
                               body: ["slug": slug, "action": disabled ? "disable" : "enable"])
    }

    // Approve a held self-enrolled member onto the roster (members.approved).
    static func approveMember(slug: String) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-member-approve",
                               body: ["slug": slug, "action": "approve"])
    }

    // Admin hand-off: promote or demote members.is_admin. The server refuses
    // to demote the last remaining admin.
    static func setMemberAdmin(slug: String, admin: Bool) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-member-role",
                               body: ["slug": slug, "action": admin ? "promote" : "demote"])
    }

    // Merge a duplicate account into the kept one: shows, contacts,
    // Apple/Google sign-in, and live sessions move; the duplicate is deleted.
    // Irreversible — callers confirm first.
    static func mergeMember(source: String, target: String) async throws -> MergeResult {
        try await postDecoding("/api/admin-member-merge",
                               body: ["source": source, "target": target])
    }

    // Operator-dismissed duplicate matches ([slug, slug] pairs; a self-pair
    // silences the hidden-email-only flag for that account).
    static func dupeIgnores() async throws -> [DupeIgnore] {
        let r: DupeIgnoresResponse = try await get("/api/admin-dupe-ignores")
        return r.ignores
    }

    static func setDupeIgnores(pairs: [[String]], ignoring: Bool) async throws -> AdminActionResult {
        try await postDecoding("/api/admin-dupe-ignores",
                               body: ["action": ignoring ? "ignore" : "unignore", "pairs": pairs])
    }

    // MARK: Admin: vibe trait scoring

    static func vibeFillStatus() async throws -> VibeFillStatus {
        try await get("/api/admin-vibe-fill")
    }

    // Score one batch. rescore=false fills only unscored titles; rescore=true
    // refreshes already-scored ones. Returns per-batch counts incl. remaining.
    static func vibeFill(count: Int, rescore: Bool) async throws -> VibeFillResult {
        var body: [String: Any] = ["count": count]
        if rescore { body["rescore"] = true }
        return try await postDecoding("/api/admin-vibe-fill", body: body)
    }

    static func startBackgroundRescore() async throws -> VibeFillResult {
        try await postDecoding("/api/admin-vibe-fill", body: ["action": "start_background_rescore"])
    }

    static func cancelBackgroundRescore() async throws -> VibeFillResult {
        try await postDecoding("/api/admin-vibe-fill", body: ["action": "cancel_background_rescore"])
    }

    // MARK: Groups

    static func groups() async throws -> GroupsResponse {
        try await get("/api/groups")
    }

    static func groupDetail(id: Int) async throws -> GroupDetail {
        try await get("/api/groups/\(id)")
    }

    static func groupTrending(id: Int) async throws -> [PopularShow] {
        struct TrendingResponse: Decodable { let shows: [PopularShow] }
        let r: TrendingResponse = try await get("/api/groups/\(id)/trending")
        return r.shows
    }

    static func createGroup(name: String) async throws -> (Group, GroupInvite) {
        struct CreateResponse: Decodable { let group: Group; let invite: GroupInvite }
        let r: CreateResponse = try await postJSON("/api/groups", body: ["name": name])
        return (r.group, r.invite)
    }

    // Creator only; 403 for anyone else. Returns the renamed group.
    static func renameGroup(id: Int, name: String) async throws -> Group {
        struct RenameResponse: Decodable { let group: Group }
        let r: RenameResponse = try await sendJSON(method: "PATCH", path: "/api/groups/\(id)", body: ["name": name])
        return r.group
    }

    static func generateGroupInvite(groupId: Int) async throws -> GroupInvite {
        try await postJSON("/api/groups/\(groupId)/invite", body: [:])
    }

    @discardableResult
    static func joinGroup(token: String) async throws -> (ok: Bool, groupId: Int) {
        struct JoinResponse: Decodable { let ok: Bool; let group_id: Int }
        let r: JoinResponse = try await get("/api/groups/join?token=\(token)")
        return (r.ok, r.group_id)
    }

    @discardableResult
    static func leaveGroup(id: Int) async throws -> Bool {
        struct Ack: Decodable { let ok: Bool? }
        let r: Ack = try await postJSON("/api/groups/\(id)/leave", body: [:])
        return r.ok ?? false
    }

    @discardableResult
    static func deleteGroup(id: Int) async throws -> Bool {
        guard let url = URL(string: baseString + "/api/groups/\(id)") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return true
    }

    // MARK: Auth

    static func loginWithEmail(email: String, code: String) async throws -> LoginResponse {
        try await postJSON("/auth/login", body: ["code": code, "email": email])
    }

    static func loginWithPhone(phone: String, code: String) async throws -> LoginResponse {
        try await postJSON("/auth/login", body: ["code": code, "phone": phone])
    }

    // Sign in with Apple: hand the verified identity token to the server, which
    // maps it to an existing member and sets the session cookie. With
    // self-enroll on, an unrecognized identity gets { needs_name: true } —
    // re-post the same token with fullName to create the account (Apple only
    // gives the name to the client, and only on first authorization).
    static func loginWithApple(identityToken: String, fullName: String? = nil) async throws -> LoginResponse {
        try await postJSON("/auth/apple", body: ["identity_token": identityToken, "full_name": fullName])
    }

    // Complete an email self-enrollment: /auth/login answered { needs_name }
    // for this email+code, and now we have the person's name. Creates the
    // member and sets the session cookie. Throws badResponse(401) invalid
    // code, (409) already a member, (403) signups closed, (429) paused.
    static func enroll(email: String, code: String, fullName: String) async throws -> LoginResponse {
        try await postJSON("/auth/enroll", body: ["email": email, "code": code, "full_name": fullName])
    }

    // Ask Twilio Verify to text a 6-digit OTP. Server replies 200 even for
    // unknown numbers (account-enumeration hardening), so a true result
    // doesn't prove the number is on file — it just means the request was
    // accepted.
    @discardableResult
    static func requestSmsCode(phone: String) async throws -> Bool {
        struct Ack: Decodable { let success: Bool? }
        let r: Ack = try await postJSON("/auth/request-code",
                                        body: ["phone": phone, "channel": "sms"])
        return r.success == true
    }

    // Ask the server to email a fresh 6-digit OTP. Server replies 200 even
    // for unknown emails (account-enumeration hardening), so a true result
    // doesn't prove the address is on file — it just means the request was
    // accepted.
    @discardableResult
    static func requestEmailCode(email: String) async throws -> Bool {
        struct Ack: Decodable { let success: Bool? }
        let r: Ack = try await postJSON("/auth/request-code",
                                        body: ["email": email, "channel": "email"])
        return r.success == true
    }

    static func logout() async {
        guard let url = URL(string: baseString + "/auth/logout") else { return }
        _ = try? await URLSession.shared.data(for: URLRequest(url: url))
    }

    // MARK: Passkeys
    //
    // Two round trips each way: the server mints a single-use challenge, the
    // device signs it, the server verifies. Sign-in sends no identifier at
    // all — the credential itself says who the member is.

    static func passkeyRegisterBegin() async throws -> PasskeyRegistrationOptions {
        try await postJSON("/auth/passkey-register-begin", body: [:])
    }

    // `label` is the device name the member sees in their passkey list.
    @discardableResult
    static func passkeyRegisterFinish(challenge: String, credentialID: String,
                                      attestationObject: String, clientDataJSON: String,
                                      label: String?) async throws -> Bool {
        struct Ack: Decodable { let success: Bool? }
        let r: Ack = try await postJSON("/auth/passkey-register-finish", body: [
            "challenge": challenge,
            "credential_id": credentialID,
            "attestation_object": attestationObject,
            "client_data_json": clientDataJSON,
            "label": label,
        ])
        return r.success == true
    }

    static func passkeyBegin() async throws -> PasskeyAssertionOptions {
        try await postJSON("/auth/passkey-begin", body: [:])
    }

    static func passkeyFinish(challenge: String, credentialID: String,
                              authenticatorData: String, clientDataJSON: String,
                              signature: String) async throws -> LoginResponse {
        try await postJSON("/auth/passkey-finish", body: [
            "challenge": challenge,
            "credential_id": credentialID,
            "authenticator_data": authenticatorData,
            "client_data_json": clientDataJSON,
            "signature": signature,
        ])
    }

    static func passkeys() async throws -> [Passkey] {
        struct Wrapper: Decodable { let passkeys: [Passkey] }
        let r: Wrapper = try await get("/api/passkeys")
        return r.passkeys
    }

    @discardableResult
    static func deletePasskey(credentialID: String) async throws -> Bool {
        // Credential ids are base64url, which is URL-safe, but percent-encode
        // anyway so the path can't be shaped by the id.
        let encoded = credentialID.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics) ?? credentialID
        guard let url = URL(string: baseString + "/api/passkeys/" + encoded) else {
            throw APIError.badURL
        }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
        return true
    }

    // MARK: Account deletion (App Store 5.1.1(v))
    //
    // Two-step hard delete, decoded regardless of HTTP status so the UI can
    // speak to the server's error (no_email / admin_must_demote_first /
    // invalid / rate_limited) instead of a bare status code.

    // Step 1: email a deletion code to the member's primary address.
    static func requestAccountDeleteCode() async throws -> AccountDeleteResponse {
        try await postDecoding("/api/account-delete", body: [:])
    }

    // Step 2: verify the code and hard-delete the account. On { deleted: true }
    // the server has already cleared the session cookie.
    static func confirmAccountDelete(code: String) async throws -> AccountDeleteResponse {
        try await postDecoding("/api/account-delete", body: ["code": code])
    }

    // MARK: Writes (require session cookie)
    //
    // Each write has a `…Remote` core that hits the network and throws on
    // failure, plus a public wrapper that — when the failure is "we're
    // offline" — queues the change locally (so the UI updates optimistically)
    // and reports success. The OfflineQueue replays the `…Remote` cores when
    // connectivity returns. Real server rejections still surface to the caller.

    @discardableResult
    // Type-ahead title search while adding a show. Session-gated
    // TMDB proxy; empty result list means "let them type freely".
    static func titleSearch(_ q: String) async throws -> [TitleHit] {
        // URLComponents escapes &/=/# in the value ( .urlQueryAllowed wouldn't,
        // truncating titles like "Law & Order"); "+" needs one extra step so
        // URLSearchParams server-side doesn't read it as a space.
        var comps = URLComponents()
        comps.queryItems = [URLQueryItem(name: "q", value: q)]
        let query = (comps.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        let r: TitleSearchResponse = try await get("/api/title-search?\(query)")
        return r.results
    }

    static func addShow(memberSlug: String, title: String, network: String?, networkUrl: String? = nil,
                        list: String, notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                        watchingWith: String?, watcherSlugs: [String]? = nil,
                        tmdbId: Int? = nil, tmdbType: String? = nil) async throws -> Show {
        do {
            let show = try await addShowRemote(memberSlug: memberSlug, title: title, network: network,
                                               networkUrl: networkUrl, list: list, notes: notes,
                                               recommendedBy: recommendedBy, movie: movie,
                                               fullSeries: fullSeries, watchingWith: watchingWith,
                                               watcherSlugs: watcherSlugs,
                                               tmdbId: tmdbId, tmdbType: tmdbType)
            await OfflineQueue.shared.upsert(show, slug: memberSlug)
            return show
        } catch {
            if isOffline(error) {
                return await OfflineQueue.shared.enqueueAdd(
                    memberSlug: memberSlug, title: title, network: network, networkUrl: networkUrl,
                    list: list, notes: notes, recommendedBy: recommendedBy, movie: movie,
                    fullSeries: fullSeries, watchingWith: watchingWith, watcherSlugs: watcherSlugs)
            }
            throw error
        }
    }

    @discardableResult
    static func addShowRemote(memberSlug: String, title: String, network: String?, networkUrl: String? = nil,
                              list: String, notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                              watchingWith: String?, watcherSlugs: [String]? = nil,
                              tmdbId: Int? = nil, tmdbType: String? = nil) async throws -> Show {
        struct Wrapper: Decodable { let show: Show }
        let body: [String: Any?] = [
            "title": title,
            "network": network,
            "network_url": networkUrl,
            "list": list,
            "notes": notes,
            "recommended_by": recommendedBy,
            "movie": movie ? 1 : 0,
            "full_series": fullSeries ? 1 : 0,
            "watching_with": watchingWith,
            // Group-mates named on the show. The server validates each slug
            // against shared group membership, links the two copies, and puts
            // the title on their list too.
            "watcher_slugs": watcherSlugs,
            // Exact type-ahead pick — the server enriches this TMDB entry
            // directly instead of re-guessing from the title.
            "tmdb_id": tmdbId,
            "tmdb_type": tmdbType,
        ]
        let r: Wrapper = try await postJSON("/api/shows", body: body)
        return r.show
    }

    @discardableResult
    static func updateShow(id: Int, title: String, network: String?, list: String,
                           notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                           watchingWith: String?, watcherSlugs: [String]? = nil,
                           archived: Bool, memberSlug: String? = nil,
                           tmdbId: Int? = nil, tmdbType: String? = nil) async throws -> Show {
        do {
            let show = try await updateShowRemote(id: id, title: title, network: network, list: list,
                                                  notes: notes, recommendedBy: recommendedBy, movie: movie,
                                                  fullSeries: fullSeries, watchingWith: watchingWith,
                                                  watcherSlugs: watcherSlugs,
                                                  archived: archived, tmdbId: tmdbId, tmdbType: tmdbType)
            if let slug = show.memberSlug ?? memberSlug { await OfflineQueue.shared.upsert(show, slug: slug) }
            return show
        } catch {
            if isOffline(error) {
                return await OfflineQueue.shared.enqueueUpdate(
                    id: id, memberSlug: memberSlug, title: title, network: network, list: list,
                    notes: notes, recommendedBy: recommendedBy, movie: movie, fullSeries: fullSeries,
                    watchingWith: watchingWith, watcherSlugs: watcherSlugs, archived: archived)
            }
            throw error
        }
    }

    @discardableResult
    static func updateShowRemote(id: Int, title: String, network: String?, list: String,
                                 notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                                 watchingWith: String?, watcherSlugs: [String]? = nil, archived: Bool,
                                 tmdbId: Int? = nil, tmdbType: String? = nil) async throws -> Show {
        struct Wrapper: Decodable { let show: Show }
        // Member-editable text fields are sent as explicit JSON null when
        // cleared (via jsonNullable) so emptying a note/recommender/watching-with
        // actually clears it instead of being dropped and kept.
        let body: [String: Any?] = [
            "title": title,
            "network": network,
            "list": list,
            "notes": jsonNullable(notes),
            "recommended_by": jsonNullable(recommendedBy),
            "movie": movie ? 1 : 0,
            "full_series": fullSeries ? 1 : 0,
            "watching_with": jsonNullable(watchingWith),
            // The COMPLETE set of named group-mates, so unticking someone
            // unlinks them. Omitted entirely (nil, dropped by compactMapValues
            // below) means "leave the links alone" — which is what a caller
            // that doesn't manage watchers wants, and what the server assumes
            // when the key is absent.
            "watcher_slugs": watcherSlugs,
            "archived": archived ? 1 : 0,
            "tmdb_id": tmdbId,
            "tmdb_type": tmdbType,
        ]
        let r: Wrapper = try await putJSON("/api/shows/\(id)", body: body)
        return r.show
    }

    static func moveShow(id: Int, to list: String) async throws {
        do {
            try await moveShowRemote(id: id, to: list)
        } catch {
            if isOffline(error) { await OfflineQueue.shared.enqueueMove(id: id, to: list) }
            else { throw error }
        }
    }

    static func moveShowRemote(id: Int, to list: String) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await putJSON("/api/shows/\(id)/move", body: ["list": list])
    }

    // Pre-save dedupe: whether the member already has this title, and where.
    struct ShowCheck: Decodable {
        let exists: Bool
        let id: Int?
        let list: String?
        let archived: Bool?
    }

    static func checkShow(title: String, member: String) async throws -> ShowCheck {
        var comps = URLComponents()
        comps.queryItems = [URLQueryItem(name: "title", value: title),
                            URLQueryItem(name: "member", value: member)]
        let query = comps.percentEncodedQuery ?? ""
        return try await get("/api/shows/check?\(query)")
    }

    // Persist the "My order" drag order for one of my lists — ids in the
    // desired top-to-bottom order. No offline queueing: the local sortOrder
    // restamp keeps the UI right, and the next successful reorder resends
    // the full order anyway.
    static func reorderShows(list: String, ids: [Int]) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await postJSON("/api/shows/reorder", body: ["list": list, "ids": ids])
    }

    static func archiveShow(id: Int) async throws {
        do {
            try await archiveShowRemote(id: id)
        } catch {
            if isOffline(error) { await OfflineQueue.shared.enqueueArchive(id: id) }
            else { throw error }
        }
    }

    static func archiveShowRemote(id: Int) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await putJSON("/api/shows/\(id)/archive", body: [:])
    }

    // Restore an archived show and drop it back onto a list in one call.
    static func restoreShow(id: Int, to list: String) async throws {
        struct Ack: Decodable {}
        let _: Ack = try await putJSON("/api/shows/\(id)", body: ["archived": 0, "list": list])
    }

    static func deleteShow(id: Int) async throws {
        do {
            try await deleteShowRemote(id: id)
        } catch {
            if isOffline(error) { await OfflineQueue.shared.enqueueDelete(id: id) }
            else { throw error }
        }
    }

    static func deleteShowRemote(id: Int) async throws {
        guard let url = URL(string: baseString + "/api/shows/\(id)") else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "DELETE"
        let (_, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badResponse((resp as? HTTPURLResponse)?.statusCode ?? -1)
        }
    }

    // MARK: Internal

    private static func postJSON<T: Decodable>(_ path: String, body: [String: Any?]) async throws -> T {
        try await sendJSON(method: "POST", path: path, body: body)
    }
    private static func putJSON<T: Decodable>(_ path: String, body: [String: Any?]) async throws -> T {
        try await sendJSON(method: "PUT", path: path, body: body)
    }
    // MARK: - List import

    // Read one slice of a pasted list. The caller loops, threading `cursor`
    // and `section` back in, until `nextCursor` comes back nil — a normal
    // paste finishes on the first call, so the loop is usually invisible.
    // Writes nothing; the rows come back for the member to review.
    //
    // `defaultList` is where a title lands when the paste says nothing about
    // it — the list the member was looking at when they opened the importer.
    // Headings in the pasted text still win over it.
    static func importParse(text: String, cursor: Int, section: String,
                            defaultList: ShowList) async throws -> ImportParseResponse {
        let body: [String: Any?] = [
            "text": text, "cursor": cursor, "section": section,
            "default_list": defaultList.rawValue,
        ]
        return try await postJSON("/api/import/parse", body: body)
    }

    // Add the reviewed rows to the caller's own lists. Batched by the caller;
    // the server caps one call at 200 rows.
    static func importCommit(items: [ImportItem]) async throws -> ImportCommitResult {
        struct Body: Encodable { let items: [ImportItem] }
        return try await postEncodable("/api/import/commit", body: Body(items: items))
    }

    // POST for bodies that are Encodable structs rather than a loose
    // dictionary — sendJSON's [String: Any?] can't carry an array of items.
    private static func postEncodable<B: Encodable, T: Decodable>(_ path: String, body: B) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(currentPlatform, forHTTPHeaderField: "X-Client-Platform")
        req.httpBody = try JSONEncoder().encode(body)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if let b = try? JSONDecoder().decode(ErrBody.self, from: data), let code = b.error {
                throw APIError.rejected(ServerRejection(status: status, code: code, id: b.id, list: b.list, title: b.title))
            }
            throw APIError.badResponse(status)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    private static func sendJSON<T: Decodable>(method: String, path: String, body: [String: Any?]) async throws -> T {
        guard let url = URL(string: baseString + path) else { throw APIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(currentPlatform, forHTTPHeaderField: "X-Client-Platform")
        // Filter out nil values so JSON omits them.
        let compact = body.compactMapValues { $0 }
        req.httpBody = try JSONSerialization.data(withJSONObject: compact)
        let (data, resp) = try await URLSession.shared.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            if let b = try? JSONDecoder().decode(ErrBody.self, from: data), let code = b.error {
                throw APIError.rejected(ServerRejection(status: status, code: code, id: b.id, list: b.list, title: b.title))
            }
            throw APIError.badResponse(status)
        }
        // Some endpoints return {} on success; tolerate empty decoding.
        if data.isEmpty || data == Data("{}".utf8) {
            // If T expects something, this will fail — but the Ack patterns above use try?.
            return try JSONDecoder().decode(T.self, from: Data("{}".utf8))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
