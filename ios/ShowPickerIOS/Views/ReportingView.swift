import SwiftUI

// Operator dashboard — mirrors the web /reporting page. GET /api/reporting.
struct ReportingView: View {
    @State private var data: Reporting?
    @State private var loading = true

    var body: some View {
        List {
            if let r = data {
                Section("Active members (sessions seen)") {
                    metric("Today", r.activeMembers.day)
                    metric("This week", r.activeMembers.week)
                    metric("This month", r.activeMembers.month)
                }
                Section("New shows") { windowRows(r.newShows) }
                Section("Edited shows") { windowRows(r.editedShows) }
                Section("Archived shows") { windowRows(r.archivedShows) }
                Section("New members") { windowRows(r.newMembers) }
                if let l = r.membersLogin, l.ever != nil || l.never != nil {
                    Section("Logins") {
                        if let e = l.ever { metric("Logged in (ever)", e) }
                        if let n = l.never { metric("Never logged in", n) }
                    }
                }
                Section("Totals") {
                    metric("Members", r.totals.members)
                    metric("Active shows", r.totals.activeShows)
                    metric("Archived shows", r.totals.archivedShows)
                    metric("Watching", r.totals.watching)
                    metric("Waiting", r.totals.waiting)
                    metric("Recommending", r.totals.recommending)
                    metric("Up Next", r.totals.next)
                }
                if !r.topNetworks.isEmpty {
                    Section("Top networks") {
                        ForEach(r.topNetworks) { metric($0.network, $0.cnt) }
                    }
                }
                if !r.topShared.isEmpty {
                    Section("Most shared titles") {
                        ForEach(r.topShared) { metric($0.title, $0.members) }
                    }
                }
            } else if !loading {
                Text("Couldn't load reporting.").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Reporting")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && data == nil { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private func windowRows(_ w: ReportWindow) -> some View {
        metric("Today", w.day)
        metric("This week", w.week)
        metric("This month", w.month)
        metric("All time", w.allTime)
    }

    private func metric(_ label: String, _ value: Int) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text("\(value)").foregroundStyle(.secondary).monospacedDigit()
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        data = try? await API.reporting()
    }
}
