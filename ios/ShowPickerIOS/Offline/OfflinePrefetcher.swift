import Foundation

// Warms the offline caches for whole lists at once. Fetching a member's shows
// already snapshots the rows themselves (OfflineQueue), but that left gaps a
// member only discovered on a plane: artwork lived in URLCache (evictable),
// and a show's detail extras — ratings summary, cast, group watchers — were
// cached only if that show had been opened while online. After every
// successful list fetch this walks the non-archived rows and fills in
// whatever's missing, so every show on every list works offline in full.
//
// Archived shows are deliberately skipped: they're browsed rarely, and
// prefetching a graveyard would multiply the work for rows nobody opens.
actor OfflinePrefetcher {
    static let shared = OfflinePrefetcher()

    // Members with a prefetch already running, so a pull-to-refresh doesn't
    // stack a second identical sweep on top of the first.
    private var inFlight: Set<String> = []

    func prefetch(shows: [Show], member slug: String) async {
        guard !inFlight.contains(slug) else { return }
        guard await MainActor.run(body: { Connectivity.shared.isOnline }) else { return }
        inFlight.insert(slug)
        defer { inFlight.remove(slug) }

        let active = shows.filter { !$0.isArchived }

        // Artwork for every fetched list — the posters the list rows draw and
        // the backdrops their detail screens lead with.
        let urls = active.flatMap { [$0.posterUrl, $0.backdropUrl] }
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        // A few at a time: enough to drain a library quickly, not enough to
        // compete with the scroll the member is actually doing.
        var iterator = Set(urls).makeIterator()
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<4 {
                guard let first = iterator.next() else { break }
                group.addTask { await ImageCache.shared.prefetch(first) }
            }
            while await group.next() != nil {
                if let next = iterator.next() {
                    group.addTask { await ImageCache.shared.prefetch(next) }
                }
            }
        }

        // Detail + cast JSON, for the member's own library only — other
        // members' lists render offline from the rows themselves, but it's
        // your own shows you actually open at 30,000 feet. Only rows the
        // cache doesn't hold yet are fetched (a visit while online refreshes
        // the rest), so a settled library costs ~nothing per sweep; the API
        // helpers write the responses into OfflineCache themselves.
        guard slug == SharedSession.memberSlug else { return }
        for show in active where show.id > 0 {   // negative = offline temp id
            guard await MainActor.run(body: { Connectivity.shared.isOnline }) else { return }
            if OfflineCache.load(ShowResponse.self, for: "show_\(show.id)") == nil {
                _ = try? await API.showDetail(id: show.id)
            }
            if OfflineCache.load(ActorsResponse.self, for: "actors_\(show.id)") == nil {
                _ = try? await API.actors(showId: show.id)
            }
        }
    }
}
