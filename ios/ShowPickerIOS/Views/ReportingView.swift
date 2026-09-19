import SwiftUI

// Operator dashboard — mirrors the web /reporting page. GET /api/reporting.
struct ReportingView: View {
    @State private var data: Reporting?
    @State private var loading = true

    var body: some View {
        List {
            if let r = data {
                Section {
                    metric("Today", r.activeMembers.day)
                    metric("This week", r.activeMembers.week)
                    metric("This month", r.activeMembers.month)
                } header: {
                    Text("Active members")
                } footer: {
                    Text("Distinct people whose session checked in during the window, on any platform. Counted per person, not per device — every Apple TV, Mac and Roku someone signs in on is still one of them.")
                }
                if let bp = r.activeByPlatform, !platformKeys(bp).isEmpty {
                    Section {
                        ForEach(platformKeys(bp), id: \.self) { key in
                            platformRow(label: platformLabel(key),
                                        day: bp.day[key] ?? 0,
                                        week: bp.week[key] ?? 0,
                                        month: bp.month[key] ?? 0)
                        }
                    } header: {
                        Text("Active by platform (people)")
                    } footer: {
                        Text("Distinct people, today / this week / this month — not sessions or devices, so three Apple TVs, two Macs or four Rokus signed in as the same person count once, and so does a reinstall. These don't add up to Active members in either direction: someone using two platforms counts on both rows, and anyone whose client never told us its platform is counted there but on no row here.")
                    }
                }
                Section("New shows") { windowRows(r.newShows) }
                Section("Edited shows") { windowRows(r.editedShows) }
                Section("Archived shows") { windowRows(r.archivedShows) }
                Section("New members") { windowRows(r.newMembers) }
                if let rm = r.ratingMembers {
                    Section("People who rated") { windowRows(rm) }
                }
                if let rs = r.ratingsSubmitted {
                    Section("Ratings submitted") { windowRows(rs) }
                }
                if let sm = r.signinMethods {
                    Section {
                        methodRows("Last 7 days", sm.week)
                        methodRows("Last 30 days", sm.month)
                        methodRows("Last 90 days", sm.quarter)
                    } header: {
                        Text("How people sign in")
                    } footer: {
                        Text("People who signed in with each method — counted once each, however many devices they used. Sessions last 30 days, so the 90-day window is the one to read before retiring a channel. Someone who used two methods counts on both, so the rows don't sum. Sessions minted before this was tracked name no channel and are left out.")
                    }
                }
                if let cal = r.calendarUsage {
                    Section {
                        metric("Feeds fetched (7 days)", cal.week)
                        metric("Feeds fetched (30 days)", cal.month)
                        metric("Feeds ever fetched", cal.ever)
                        metric("Total fetches", cal.fetches)
                    } header: {
                        Text("Calendar")
                    } footer: {
                        Text("A subscribed calendar polls on its own schedule, so a member whose feed is being fetched has it live somewhere. Counting started when this shipped — give it a day before reading it.")
                    }
                }
                if let ev = r.enrolledVia, !ev.isEmpty {
                    Section {
                        ForEach(ev.sorted(by: { $0.value > $1.value }), id: \.key) { pair in
                            metric(Self.methodLabel(pair.key), pair.value)
                        }
                    } header: {
                        Text("How accounts were created")
                    } footer: {
                        Text("All time. Retiring a sign-in channel means the accounts created through it need another way in.")
                    }
                }
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
                    metric("Loved", r.totals.recommending)
                    metric("Next Up", r.totals.next)
                    if let titles = r.ratingsTitles { metric("Titles rated", titles) }
                }
                if let g = r.generatedAt, let when = Self.generatedLine(g) {
                    Section { Text(when).font(.caption).foregroundStyle(.secondary) }
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

    // One window of sign-in methods: "Last 30 days — Apple 14 · Email 3".
    // The counts are people per method, and someone who used two methods is on
    // both rows, so there is no total to show: summing them would count that
    // person twice, which is the whole thing these numbers are trying not to
    // do. The window shows its breakdown or says it saw nobody.
    @ViewBuilder private func methodRows(_ label: String, _ counts: [String: Int]) -> some View {
        let used = counts.filter { $0.value > 0 }.sorted { $0.value > $1.value }
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
            Text(used.isEmpty
                 ? "No sign-ins"
                 : used.map { "\(Self.methodLabel($0.key)) \($0.value)" }.joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    private static func methodLabel(_ key: String) -> String {
        switch key {
        case "apple": return "Apple"
        case "google": return "Google"
        case "email": return "Email code"
        case "sms": return "Text code"
        case "demo": return "Demo account"
        default: return key.capitalized
        }
    }

    // "Generated Aug 4, 2026 at 1:12 PM" — says how stale the numbers are,
    // which matters on a report you can leave open.
    private static func generatedLine(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? {
            parser.formatOptions = [.withInternetDateTime]
            return parser.date(from: iso)
        }()
        guard let date else { return nil }
        let f = DateFormatter()
        f.dateStyle = .medium
        f.timeStyle = .short
        return "Generated \(f.string(from: date))"
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

    // Stable display order for the platform breakdown; unrecognized keys sort
    // last. "ios" is a legacy value from before iPhone/iPad/Mac were told
    // apart — kept because rows stored before KNOWN_PLATFORMS gated the header
    // can still carry it. There is deliberately no "unknown": the server omits
    // sessions whose platform it never captured rather than naming them.
    private static let platformOrder = ["iphone", "ipad", "mac", "watchos", "tvos", "roku", "web-large", "web-small", "ios"]

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
        case "iphone": return "iPhone"
        case "ipad": return "iPad"
        case "mac": return "Mac"
        case "watchos": return "Apple Watch"
        case "tvos": return "Apple TV"
        case "roku": return "Roku"
        case "web-large": return "Web (large)"
        case "web-small": return "Web (small)"
        case "ios": return "iOS (legacy)"
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
