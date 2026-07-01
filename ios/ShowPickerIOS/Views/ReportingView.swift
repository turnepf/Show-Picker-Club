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
                if let bp = r.activeByPlatform, !platformKeys(bp).isEmpty {
                    Section("Active by platform (sessions)") {
                        ForEach(platformKeys(bp), id: \.self) { key in
                            platformRow(label: platformLabel(key),
                                        day: bp.day[key] ?? 0,
                                        week: bp.week[key] ?? 0,
                                        month: bp.month[key] ?? 0)
                        }
                    }
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
                if let never = r.neverLoggedIn, !never.isEmpty {
                    Section("Never logged in (\(never.count))") {
                        ForEach(never) { m in
                            HStack {
                                Text(m.displayName)
                                Spacer()
                                Text(m.libraryStatus)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                Section("Totals") {
                    metric("Members", r.totals.members)
                    metric("Active shows", r.totals.activeShows)
                    metric("Archived shows", r.totals.archivedShows)
                    metric("Watching", r.totals.watching)
                    metric("Awaiting", r.totals.waiting)
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

    // Stable display order for the platform breakdown; unknown keys sort last.
    private static let platformOrder = ["ios", "tvos", "web-large", "web-small", "unknown"]

    private func platformKeys(_ bp: PlatformWindows) -> [String] {
        var keys = Set(bp.day.keys)
        keys.formUnion(bp.week.keys)
        keys.formUnion(bp.month.keys)
        let known = Self.platformOrder.filter { keys.contains($0) }
        let extra = keys.subtracting(Self.platformOrder).sorted()
        return known + extra
    }

    private func platformLabel(_ key: String) -> String {
        switch key {
        case "ios": return "iOS"
        case "tvos": return "tvOS"
        case "web-large": return "Web (large)"
        case "web-small": return "Web (small)"
        case "unknown": return "Unknown"
        default: return key
        }
    }

    private func platformRow(label: String, day: Int, week: Int, month: Int) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text("\(day) / \(week) / \(month)")
                .foregroundStyle(.secondary).monospacedDigit()
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        data = try? await API.reporting()
    }
}
