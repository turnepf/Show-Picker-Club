import SwiftUI

// What's coming up on your own lists, by date — premieres for shows you're
// watching or awaiting, and the finale dates we know about. The same data the
// /calendar/<slug>.ics feed carries, readable without subscribing to anything:
// the Home row used to fire webcal:// straight at the OS, which is a dead end
// for anyone who doesn't want a subscription calendar.
struct CalendarView: View {
    let member: Member

    @State private var items: [DatedRelease] = []
    @State private var loading = true
    @State private var loadFailed = false
    @Environment(\.openURL) private var openURL

    // One dated thing on the calendar. A show can contribute both a premiere
    // and a finale, so the id carries the kind as well as the row.
    struct DatedRelease: Identifiable {
        enum Kind { case premiere, finale }
        let show: Show
        let date: Date
        let day: String          // the raw YYYY-MM-DD, for grouping
        let kind: Kind

        var id: String { "\(show.id)-\(kind == .premiere ? "p" : "f")" }
        var label: String { kind == .premiere ? "Premieres" : "Finale" }
    }

    var body: some View {
        List {
            Section {
                Button {
                    if let url = subscribeURL { openURL(url) }
                } label: {
                    Label {
                        Text("Subscribe in Calendar").foregroundStyle(.primary)
                    } icon: {
                        Image(systemName: "calendar.badge.plus")
                    }
                }
                .disabled(subscribeURL == nil)
            } footer: {
                Text(subscribeURL == nil
                     ? "Log in on this device to subscribe to your feed."
                     : "Adds these dates to your calendar app, kept up to date as your lists change. Paused subscriptions with a resubscribe date land there too.")
            }

            if items.isEmpty && !loading {
                Section {
                    Text(loadFailed
                         ? "Couldn't load your shows — pull down to try again."
                         : "Nothing dated coming up. Premiere dates appear here as soon as a show you're watching or awaiting announces one.")
                        .foregroundStyle(.secondary)
                }
            }

            ForEach(months, id: \.key) { month in
                Section(month.key) {
                    ForEach(month.items) { item in
                        NavigationLink(value: Route.detail(id: item.show.id, title: item.show.title,
                                                           network: item.show.network, rating: item.show.rating)) {
                            ShowRow(item.show, caption: caption(item), showRating: false)
                        }
                    }
                }
            }
        }
        .navigationTitle("Calendar")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && items.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    // "Premieres Tue, Mar 3 · Netflix" — the date leads, since that's what
    // this screen is sorted by.
    private func caption(_ item: DatedRelease) -> String {
        let when = Self.display.string(from: item.date)
        guard let n = item.show.network, !n.isEmpty else { return "\(item.label) \(when)" }
        return "\(item.label) \(when) · \(n)"
    }

    private var subscribeURL: URL? {
        guard let token = member.calendarToken, !token.isEmpty else { return nil }
        let slug = member.slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? member.slug
        return URL(string: "webcal://showpicker.club/calendar/\(slug).ics?key=\(token)")
    }

    // Grouped by month so a long list stays scannable; months are already in
    // order because the items are.
    private var months: [(key: String, items: [DatedRelease])] {
        var order: [String] = []
        var buckets: [String: [DatedRelease]] = [:]
        for item in items {
            let key = Self.monthHeader.string(from: item.date)
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(item)
        }
        return order.map { ($0, buckets[$0] ?? []) }
    }

    @MainActor
    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let shows = try await API.shows(member: member.slug)
            loadFailed = false
            items = Self.upcoming(from: shows)
        } catch {
            loadFailed = true
        }
    }

    // Every dated thing from today forward, soonest first. Archived rows and
    // the two undated lists (Loved, Next Up) carry no dates worth showing —
    // a premiere only matters for something you're watching or waiting on.
    static func upcoming(from shows: [Show]) -> [DatedRelease] {
        let today = Calendar.current.startOfDay(for: Date())
        var out: [DatedRelease] = []
        for show in shows where !show.isArchived {
            guard show.list == ShowList.watching.rawValue || show.list == ShowList.waiting.rawValue else { continue }
            if let d = show.nextSeasonDate, let date = parseDay(d), date >= today {
                out.append(DatedRelease(show: show, date: date, day: d, kind: .premiere))
            }
            if let d = show.seasonEndDate, let date = parseDay(d), date >= today {
                out.append(DatedRelease(show: show, date: date, day: d, kind: .finale))
            }
        }
        return out.sorted { $0.date == $1.date ? $0.show.title < $1.show.title : $0.date < $1.date }
    }

    // Dates arrive as plain "YYYY-MM-DD" days, not timestamps.
    private static let dayParser: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func parseDay(_ s: String) -> Date? {
        guard !s.isEmpty else { return nil }
        return dayParser.date(from: s)
    }

    private static let display: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "EEE, MMM d"
        return f
    }()

    private static let monthHeader: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMMM yyyy"
        return f
    }()
}
