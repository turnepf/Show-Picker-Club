import SwiftUI
import ShowPickerCore

// Screen 2: the shows on one list. Title, then the two facts worth a glance
// without opening anything: where it airs (with the premiere/finale date when
// there is one) and its rating. Tapping opens the detail.
struct ListShowsView: View {
    let list: ShowList
    let shows: [Show]

    var body: some View {
        List {
            ForEach(sorted) { show in
                NavigationLink {
                    WatchDetailView(show: show)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(show.title).font(.headline).lineLimit(2)
                        if let sub = subtitle(show) {
                            Text(sub).font(.caption2).foregroundStyle(.secondary)
                        }
                        if let r = show.rating, !r.isEmpty {
                            Text("★ \(r)").font(.caption2).foregroundStyle(.orange)
                        }
                    }
                }
            }
            // Per-network counts, mirroring the web list footer.
            if let counts = NetworkTally.line(for: shows) {
                Text(counts)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .listRowBackground(Color.clear)
            }
        }
        .navigationTitle(list.title)
        .overlay {
            if shows.isEmpty {
                Text("Nothing here yet.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    // "Netflix · 6/12" — the network, plus the premiere date (or the finale's,
    // when that's all there is). Either half alone still renders.
    private func subtitle(_ show: Show) -> String? {
        let parts = [show.network, show.seasonDatesText]
            .compactMap { $0 }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // Watching/Awaiting lead with the soonest premiere; the rest by rating —
    // matching the phone and TV apps. A "My Order" arrangement dragged on
    // web/iOS wins when one exists (the watch has no sort UI of its own).
    private var sorted: [Show] { shows.orderedForList(list) }
}
