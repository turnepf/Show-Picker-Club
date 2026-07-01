import SwiftUI
import ShowPickerCore

// Screen 2: the shows on one list — just the title and network, per spec.
// Tapping opens the detail.
struct ListShowsView: View {
    let list: ShowList
    let shows: [Show]

    var body: some View {
        List(sorted) { show in
            NavigationLink {
                WatchDetailView(show: show)
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(show.title).font(.headline).lineLimit(2)
                    if let n = show.network, !n.isEmpty {
                        Text(n).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle(list.title)
        .overlay {
            if shows.isEmpty {
                Text("Nothing here yet.").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    // Watching/Awaiting lead with the soonest premiere; the rest by rating —
    // matching the phone and TV apps.
    private var sorted: [Show] {
        if list == .watching || list == .waiting {
            return shows.sorted { a, b in
                let da = (a.nextSeasonDate?.isEmpty == false) ? a.nextSeasonDate! : "9999-12-31"
                let db = (b.nextSeasonDate?.isEmpty == false) ? b.nextSeasonDate! : "9999-12-31"
                if da != db { return da < db }
                return (Double(a.rating ?? "0") ?? 0) > (Double(b.rating ?? "0") ?? 0)
            }
        }
        return shows.sorted { (Double($0.rating ?? "0") ?? 0) > (Double($1.rating ?? "0") ?? 0) }
    }
}
