import Foundation
import Combine

// The offline write engine plus the editable shows-per-member cache.
//
// Two jobs:
//   1. Hold the last server snapshot of each member's shows (`base`) and the
//      derived view the UI reads when offline (`localShows` = base + pending
//      applied). API.shows(member:) refreshes `base` when online and reads
//      `localShows` when offline.
//   2. Queue writes made while offline (`pending`) and replay them in order
//      when connectivity returns (`flush`), remapping the temporary ids that
//      offline adds were given to the real ids the server assigns.
@MainActor
final class OfflineQueue: ObservableObject {
    static let shared = OfflineQueue()

    @Published private(set) var pending: [PendingMutation] = []
    @Published private(set) var isFlushing = false
    // base + pending applied; what views render when the network is down.
    @Published private(set) var localShows: [String: [Show]] = [:]

    // Last clean server snapshot per member, before local edits.
    private var base: [String: [Show]] = [:]

    private let pendingKey = "pending_mutations"
    private let baseKey = "shows_base"
    private let tempIdKey = "offline_next_temp_id"

    private init() {
        pending = OfflineCache.load([PendingMutation].self, for: pendingKey) ?? []
        base = OfflineCache.load([String: [Show]].self, for: baseKey) ?? []
        rebuildAll()
    }

    var pendingCount: Int { pending.count }

    func pendingCount(forMember slug: String) -> Int {
        pending.filter { $0.memberSlug == slug }.count
    }

    // MARK: - Reads

    func shows(for slug: String, includeArchived: Bool = false) -> [Show] {
        let all = localShows[slug] ?? []
        return includeArchived ? all : all.filter { !$0.isArchived }
    }

    func cachedShow(id: Int) -> Show? {
        for list in localShows.values {
            if let s = list.first(where: { $0.id == id }) { return s }
        }
        return nil
    }

    // Refresh the clean snapshot for a member from a successful fetch, then
    // re-layer any still-pending edits so optimistic state survives a reload.
    func replaceMember(_ slug: String, shows: [Show]) {
        base[slug] = shows
        persistBase()
        rebuild(slug)
    }

    // Fold a single server-confirmed show back into the snapshot (after an
    // online write) so the UI stays correct without a full refetch.
    func upsert(_ show: Show, slug: String) {
        var list = base[slug] ?? []
        if let i = list.firstIndex(where: { $0.id == show.id }) { list[i] = show }
        else { list.append(show) }
        base[slug] = list
        persistBase()
        rebuild(slug)
    }

    // MARK: - Enqueue (called by API when a write fails because we're offline)

    @discardableResult
    func enqueueAdd(memberSlug: String, title: String, network: String?, networkUrl: String?,
                    list: String, notes: String?, recommendedBy: String?, movie: Bool,
                    fullSeries: Bool, watchingWith: String?) -> Show {
        var m = PendingMutation(kind: .add, showId: nextTempId(), memberSlug: memberSlug)
        m.title = title
        m.network = network
        m.networkUrl = networkUrl
        m.list = list
        m.notes = notes
        m.recommendedBy = recommendedBy
        m.movie = movie
        m.fullSeries = fullSeries
        m.watchingWith = watchingWith
        append(m)
        return makeShow(from: m)
    }

    @discardableResult
    func enqueueUpdate(id: Int, memberSlug: String?, title: String, network: String?, list: String,
                       notes: String?, recommendedBy: String?, movie: Bool, fullSeries: Bool,
                       watchingWith: String?, archived: Bool) -> Show {
        let slug = memberSlug ?? cachedShow(id: id)?.memberSlug
        var m = PendingMutation(kind: .update, showId: id, memberSlug: slug)
        m.title = title
        m.network = network
        m.list = list
        m.notes = notes
        m.recommendedBy = recommendedBy
        m.movie = movie
        m.fullSeries = fullSeries
        m.watchingWith = watchingWith
        m.archived = archived
        append(m)
        // Return the show as it now looks locally (keeps enrichment fields).
        return cachedShow(id: id) ?? makeShow(from: m)
    }

    func enqueueMove(id: Int, to list: String) {
        var m = PendingMutation(kind: .move, showId: id, memberSlug: cachedShow(id: id)?.memberSlug)
        m.targetList = list
        append(m)
    }

    func enqueueArchive(id: Int) {
        let m = PendingMutation(kind: .archive, showId: id, memberSlug: cachedShow(id: id)?.memberSlug)
        append(m)
    }

    func enqueueDelete(id: Int) {
        let m = PendingMutation(kind: .delete, showId: id, memberSlug: cachedShow(id: id)?.memberSlug)
        append(m)
    }

    private func append(_ m: PendingMutation) {
        pending.append(m)
        persistPending()
        if let slug = m.memberSlug { rebuild(slug) } else { rebuildAll() }
    }

    // MARK: - Flush

    func flush() async {
        guard !isFlushing, !pending.isEmpty, Connectivity.shared.isOnline else { return }
        isFlushing = true
        defer { isFlushing = false }

        var remap: [Int: Int] = [:]   // temp add id -> real server id
        // Snapshot the queue; we mutate `pending` as each one succeeds.
        let work = pending
        for m in work {
            var resolved = m
            if let real = remap[resolved.showId] { resolved.showId = real }
            do {
                if let mapping = try await replay(resolved) {
                    remap[mapping.tempId] = mapping.realId
                }
                remove(m.id)
            } catch {
                if API.isOffline(error) {
                    // Lost the connection mid-drain — keep the rest for later.
                    return
                }
                // A real server rejection (e.g. the show was deleted on the
                // web): this mutation can never succeed, so drop it and move on
                // rather than wedging the whole queue.
                remove(m.id)
            }
        }
    }

    // Replays one mutation. Returns the temp→real id mapping when it was an add,
    // so later mutations referencing the new show can be retargeted.
    private func replay(_ m: PendingMutation) async throws -> (tempId: Int, realId: Int)? {
        switch m.kind {
        case .add:
            let show = try await API.addShowRemote(
                memberSlug: m.memberSlug ?? "", title: m.title ?? "", network: m.network,
                networkUrl: m.networkUrl, list: m.list ?? ShowList.watching.rawValue,
                notes: m.notes, recommendedBy: m.recommendedBy, movie: m.movie ?? false,
                fullSeries: m.fullSeries ?? false, watchingWith: m.watchingWith)
            if let slug = m.memberSlug { replaceTempId(m.showId, with: show, slug: slug) }
            return (m.showId, show.id)
        case .update:
            _ = try await API.updateShowRemote(
                id: m.showId, title: m.title ?? "", network: m.network,
                list: m.list ?? ShowList.watching.rawValue, notes: m.notes,
                recommendedBy: m.recommendedBy, movie: m.movie ?? false,
                fullSeries: m.fullSeries ?? false, watchingWith: m.watchingWith,
                archived: m.archived ?? false)
            return nil
        case .move:
            try await API.moveShowRemote(id: m.showId, to: m.targetList ?? ShowList.watching.rawValue)
            return nil
        case .archive:
            try await API.archiveShowRemote(id: m.showId)
            return nil
        case .delete:
            try await API.deleteShowRemote(id: m.showId)
            return nil
        }
    }

    // MARK: - Account lifecycle

    func reset() {
        pending = []
        base = [:]
        localShows = [:]
        OfflineCache.remove(for: pendingKey)
        OfflineCache.remove(for: baseKey)
    }

    // MARK: - Derivation

    private func rebuildAll() {
        var result: [String: [Show]] = [:]
        for slug in Set(base.keys).union(pending.compactMap { $0.memberSlug }) {
            result[slug] = derived(for: slug)
        }
        localShows = result
    }

    private func rebuild(_ slug: String) {
        localShows[slug] = derived(for: slug)
    }

    private func derived(for slug: String) -> [Show] {
        var shows = base[slug] ?? []
        for m in pending where (m.memberSlug ?? cachedSlug(forId: m.showId)) == slug {
            apply(m, to: &shows)
        }
        return shows
    }

    // Best-effort lookup of which member a bare-id mutation belongs to, by
    // scanning the snapshots (used when a mutation didn't capture its slug).
    private func cachedSlug(forId id: Int) -> String? {
        for (slug, list) in base where list.contains(where: { $0.id == id }) { return slug }
        return nil
    }

    private func apply(_ m: PendingMutation, to shows: inout [Show]) {
        switch m.kind {
        case .add:
            if !shows.contains(where: { $0.id == m.showId }) {
                shows.append(makeShow(from: m))
            }
        case .update:
            if let i = shows.firstIndex(where: { $0.id == m.showId }) {
                shows[i] = applyEdits(m, to: shows[i])
            }
        case .move:
            if let i = shows.firstIndex(where: { $0.id == m.showId }), let t = m.targetList {
                shows[i] = shows[i].with(list: t)
            }
        case .archive:
            if let i = shows.firstIndex(where: { $0.id == m.showId }) {
                shows[i] = shows[i].with(archived: true)
            }
        case .delete:
            shows.removeAll { $0.id == m.showId }
        }
    }

    // Swap a freshly-created show's temp id for its real one in the snapshot.
    private func replaceTempId(_ tempId: Int, with show: Show, slug: String) {
        var list = base[slug] ?? []
        list.removeAll { $0.id == tempId }
        if !list.contains(where: { $0.id == show.id }) { list.append(show) }
        base[slug] = list
        persistBase()
        rebuild(slug)
    }

    // MARK: - Building Show values

    private func makeShow(from m: PendingMutation) -> Show {
        Show(id: m.showId, title: m.title ?? "", network: m.network, networkUrl: m.networkUrl,
             recommendedBy: m.recommendedBy, rating: nil, list: m.list ?? ShowList.watching.rawValue,
             notes: m.notes, movie: (m.movie ?? false) ? 1 : 0,
             fullSeries: (m.fullSeries ?? false) ? 1 : 0, watchingWith: m.watchingWith,
             nextSeasonDate: nil, seasonEndDate: nil, genres: nil, actors: nil,
             archived: (m.archived ?? false) ? 1 : 0, memberSlug: m.memberSlug,
             createdAt: ISO8601DateFormatter().string(from: m.createdAt))
    }

    private func applyEdits(_ m: PendingMutation, to s: Show) -> Show {
        Show(id: s.id, title: m.title ?? s.title, network: m.network, networkUrl: s.networkUrl,
             recommendedBy: m.recommendedBy, rating: s.rating, list: m.list ?? s.list,
             notes: m.notes, movie: (m.movie ?? false) ? 1 : 0,
             fullSeries: (m.fullSeries ?? false) ? 1 : 0, watchingWith: m.watchingWith,
             nextSeasonDate: s.nextSeasonDate, seasonEndDate: s.seasonEndDate, genres: s.genres,
             actors: s.actors, archived: (m.archived ?? false) ? 1 : 0, memberSlug: s.memberSlug,
             createdAt: s.createdAt)
    }

    // MARK: - Temp ids & persistence

    private func nextTempId() -> Int {
        let current = UserDefaults.standard.integer(forKey: tempIdKey)   // 0 first time
        let next = current - 1                                            // -1, -2, -3, …
        UserDefaults.standard.set(next, forKey: tempIdKey)
        return next
    }

    private func remove(_ id: UUID) {
        pending.removeAll { $0.id == id }
        persistPending()
        rebuildAll()
    }

    private func persistPending() { OfflineCache.save(pending, for: pendingKey) }
    private func persistBase() { OfflineCache.save(base, for: baseKey) }
}

// Copy-with helpers — Show's stored fields are all `let`, so offline edits
// rebuild a new value rather than mutating in place.
private extension Show {
    func with(list: String) -> Show {
        Show(id: id, title: title, network: network, networkUrl: networkUrl,
             recommendedBy: recommendedBy, rating: rating, list: list, notes: notes,
             movie: movie, fullSeries: fullSeries, watchingWith: watchingWith,
             nextSeasonDate: nextSeasonDate, seasonEndDate: seasonEndDate, genres: genres,
             actors: actors, archived: archived, memberSlug: memberSlug, createdAt: createdAt)
    }

    func with(archived: Bool) -> Show {
        Show(id: id, title: title, network: network, networkUrl: networkUrl,
             recommendedBy: recommendedBy, rating: rating, list: list, notes: notes,
             movie: movie, fullSeries: fullSeries, watchingWith: watchingWith,
             nextSeasonDate: nextSeasonDate, seasonEndDate: seasonEndDate, genres: genres,
             actors: actors, archived: archived ? 1 : 0, memberSlug: memberSlug, createdAt: createdAt)
    }
}
