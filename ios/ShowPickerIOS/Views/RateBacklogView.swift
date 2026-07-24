import SwiftUI

// The one-page "rate your backlog" bulk flow — mirrors public/rate-backlog.html.
// Lists every show the member hasn't given an overall rating yet; tapping a
// rating removes that show from the list immediately (whether it synced
// right away or just got queued for offline replay) rather than sticking
// around showing a score. Season ratings aren't listed here — overall
// only, by design; "Rate seasons" opens the full detail screen instead.
struct RateBacklogView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var shows: [RateBacklogShow] = []
    @State private var hasAny = false
    @State private var loading = true
    @State private var loadFailed = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if loadFailed {
                ContentUnavailableView("Couldn’t Load", systemImage: "wifi.slash",
                    description: Text("Check your connection and try again."))
            } else if shows.isEmpty {
                ContentUnavailableView(
                    hasAny ? "All Rated!" : "Nothing to Rate Yet",
                    systemImage: hasAny ? "checkmark.circle" : "star",
                    description: Text(hasAny
                        ? "You've rated everything in your backlog. Season ratings aren't tracked here — open a show's detail page for those."
                        : "Add some shows to Watching, Awaiting, or Loved first.")
                )
            } else {
                List(shows) { show in
                    RateBacklogRow(show: show) { value in
                        await rate(show, value: value)
                    }
                }
                .listStyle(.plain)
            }
        }
        .navigationTitle("Rate My Backlog")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .alert("Couldn’t Save Rating",
               isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } }),
               presenting: errorMessage) { _ in
            Button("OK", role: .cancel) { }
        } message: { Text($0) }
    }

    private func load() async {
        guard let slug = auth.memberSlug else { loading = false; return }
        do {
            let r = try await API.rateBacklog(member: slug)
            // Drop anything already rated offline this session so it
            // doesn't reappear before the queue actually syncs it.
            shows = r.shows.filter { OfflineQueue.shared.pendingRating(showId: $0.id, season: nil) == nil }
            hasAny = r.hasAny
            loadFailed = false
        } catch {
            loadFailed = shows.isEmpty
        }
        loading = false
    }

    private func rate(_ show: RateBacklogShow, value: Int) async {
        do {
            _ = try await API.rateShow(id: show.id, rating: value, season: nil)
            shows.removeAll { $0.id == show.id }
        } catch let e as API.APIError where e.status == 401 {
            errorMessage = "Your session expired — sign in again from Home."
        } catch {
            errorMessage = "Something went wrong. Please try again."
        }
    }
}

// One row: poster, title, list label, tap-row. "Rate seasons" links to the
// full detail screen for TV shows with a known season count.
private struct RateBacklogRow: View {
    let show: RateBacklogShow
    let onRate: (Int) async -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            PosterThumb(url: show.posterUrl, width: 44, height: 66)
            VStack(alignment: .leading, spacing: 6) {
                Text(show.title).font(.subheadline).fontWeight(.semibold)
                HStack(spacing: 8) {
                    if let label = ShowList(rawValue: show.list)?.title {
                        Text(label).font(.caption).foregroundStyle(.secondary)
                    }
                    if !show.isMovie, let n = show.seasonsReleased, n > 0 {
                        NavigationLink("Rate seasons") {
                            ShowDetailView(id: show.id, initialTitle: show.title,
                                          initialNetwork: nil, initialRating: nil,
                                          initialPoster: show.posterUrl)
                        }
                        .font(.caption)
                    }
                }
                RatingTapRow(value: nil) { value in
                    Task { await onRate(value) }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
