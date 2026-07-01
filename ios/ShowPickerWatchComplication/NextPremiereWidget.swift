import WidgetKit
import SwiftUI
import ShowPickerCore

// MARK: - Timeline entry

// One rendered state of the complication. `premiere` is nil when nothing is
// scheduled (or we're not signed in yet). Relative text ("in 3 days") is
// computed against `date`, so a per-day timeline keeps it accurate.
struct PremiereEntry: TimelineEntry {
    let date: Date
    let title: String?
    let network: String?
    let premiereDate: Date?

    static func empty(_ date: Date) -> PremiereEntry {
        PremiereEntry(date: date, title: nil, network: nil, premiereDate: nil)
    }
}

// MARK: - Provider

struct NextPremiereProvider: TimelineProvider {
    func placeholder(in context: Context) -> PremiereEntry {
        PremiereEntry(date: Date(), title: "House of the Dragon",
                      network: "HBO Max", premiereDate: Date().addingTimeInterval(3 * 86_400))
    }

    func getSnapshot(in context: Context, completion: @escaping (PremiereEntry) -> Void) {
        if context.isPreview {
            completion(placeholder(in: context))
            return
        }
        Task { completion(await entry(for: Date())) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PremiereEntry>) -> Void) {
        Task {
            let now = Date()
            let shows = await loadShows()
            let base = makeEntry(shows: shows, at: now)

            // A per-day timeline so the "in N days" / "Today" text updates at
            // each local midnight without a network round-trip.
            var entries = [base]
            let cal = Calendar.current
            if let premiere = base.premiereDate {
                var day = cal.startOfDay(for: now)
                for _ in 0..<21 {
                    guard let next = cal.date(byAdding: .day, value: 1, to: day) else { break }
                    day = next
                    if day > premiere { break }
                    entries.append(makeEntry(shows: shows, at: day))
                }
            }

            // Refetch twice a day to catch new adds / date changes; the watch app
            // also nudges us via WidgetCenter when your session or lists change.
            let refresh = cal.date(byAdding: .hour, value: 12, to: now) ?? now.addingTimeInterval(43_200)
            completion(Timeline(entries: entries, policy: .after(refresh)))
        }
    }

    private func entry(for date: Date) async -> PremiereEntry {
        makeEntry(shows: await loadShows(), at: date)
    }

    private func makeEntry(shows: [Show], at date: Date) -> PremiereEntry {
        guard let next = Premiere.next(from: shows, on: date) else { return .empty(date) }
        return PremiereEntry(date: date, title: next.title,
                             network: next.network, premiereDate: next.nextSeasonDay)
    }

    // Public read: the member slug (handed off from the phone, cached in the
    // shared App Group) is all we need. Returns [] if we're not signed in or the
    // fetch fails — the view then shows the empty state.
    private func loadShows() async -> [Show] {
        guard let slug = WatchShared.memberSlug,
              let enc = slug.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "https://showpicker.club/api/shows?member=\(enc)")
        else { return [] }

        var req = URLRequest(url: url)
        req.httpShouldHandleCookies = false
        if let cookie = WatchShared.cookieHeader, !cookie.isEmpty {
            req.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        req.setValue("watchos", forHTTPHeaderField: "X-Client-Platform")
        req.cachePolicy = .reloadRevalidatingCacheData

        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
              let decoded = try? JSONDecoder().decode(ShowsResponse.self, from: data)
        else { return [] }
        return decoded.shows
    }
}

// MARK: - Views

struct NextPremiereWidget: Widget {
    let kind = "ShowPickerNextPremiere"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NextPremiereProvider()) { entry in
            NextPremiereView(entry: entry)
        }
        .configurationDisplayName("Next Premiere")
        .description("The next show premiering from your Watching and Awaiting lists.")
        .supportedFamilies([
            .accessoryRectangular,
            .accessoryInline,
            .accessoryCircular,
            .accessoryCorner,
        ])
    }
}

struct NextPremiereView: View {
    @Environment(\.widgetFamily) private var family
    let entry: PremiereEntry

    var body: some View {
        switch family {
        case .accessoryRectangular: rectangular
        case .accessoryInline:      inline
        case .accessoryCircular:    circular
        case .accessoryCorner:      corner
        default:                    inline
        }
    }

    // MARK: Rectangular — the richest family: label, title, date + relative.
    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label("Next Premiere", systemImage: "tv")
                .font(.caption2).foregroundStyle(.secondary)
                .labelStyle(.titleAndIcon)
            if let title = entry.title {
                Text(title).font(.headline).lineLimit(1)
                if let d = entry.premiereDate {
                    Text("\(Self.dayLabel(d)) · \(Self.relative(d, from: entry.date))")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Text("No premieres scheduled")
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Inline — a single line in the watch face's slot.
    private var inline: some View {
        if let title = entry.title, let d = entry.premiereDate {
            return Label("\(title) · \(Self.dayLabel(d))", systemImage: "tv")
        } else {
            return Label("No premieres", systemImage: "tv")
        }
    }

    // MARK: Circular — tiny and round: days-until on top of a date, or an icon.
    private var circular: some View {
        Group {
            if let d = entry.premiereDate {
                VStack(spacing: 0) {
                    Text(Self.shortCount(d, from: entry.date))
                        .font(.system(size: 18, weight: .bold))
                        .minimumScaleFactor(0.6)
                    Text(Self.dayLabel(d))
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                        .minimumScaleFactor(0.6)
                }
            } else {
                Image(systemName: "tv")
            }
        }
        .widgetAccentable()
    }

    // MARK: Corner — icon plus a short curved label.
    private var corner: some View {
        Group {
            if let d = entry.premiereDate {
                Image(systemName: "tv")
                    .widgetLabel(Self.dayLabel(d))
            } else {
                Image(systemName: "tv")
                    .widgetLabel("No premieres")
            }
        }
        .widgetAccentable()
    }

    // MARK: Formatting helpers

    // "Jun 16" — month + day, no year.
    static func dayLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US")
        f.setLocalizedDateFormatFromTemplate("MMMd")
        return f.string(from: date)
    }

    // "Today" / "Tomorrow" / "in 3 days" relative to the entry's day.
    static func relative(_ premiere: Date, from now: Date) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day],
                                      from: cal.startOfDay(for: now),
                                      to: cal.startOfDay(for: premiere)).day ?? 0
        switch days {
        case ..<0:  return "premiered"
        case 0:     return "Today"
        case 1:     return "Tomorrow"
        default:    return "in \(days) days"
        }
    }

    // Compact count for the round face: "TDY" / "1d" / "12d".
    static func shortCount(_ premiere: Date, from now: Date) -> String {
        let cal = Calendar.current
        let days = cal.dateComponents([.day],
                                      from: cal.startOfDay(for: now),
                                      to: cal.startOfDay(for: premiere)).day ?? 0
        return days <= 0 ? "TDY" : "\(days)d"
    }
}
