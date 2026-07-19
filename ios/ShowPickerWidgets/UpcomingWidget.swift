import WidgetKit
import SwiftUI
import UIKit

// MARK: - Timeline

struct UpcomingEntry: TimelineEntry {
    let date: Date
    let shows: [WidgetShow]   // soonest first
    let signedIn: Bool

    static func placeholder(_ date: Date) -> UpcomingEntry {
        UpcomingEntry(date: date, shows: [
            WidgetShow(id: 1, title: "House of the Dragon", network: "HBO Max", rating: "8.4",
                       membersText: nil, premiereDate: date.addingTimeInterval(3 * 86_400), posterData: nil),
            WidgetShow(id: 2, title: "Slow Horses", network: "Apple TV+", rating: "8.2",
                       membersText: nil, premiereDate: date.addingTimeInterval(9 * 86_400), posterData: nil),
            WidgetShow(id: 3, title: "Severance", network: "Apple TV+", rating: "8.7",
                       membersText: nil, premiereDate: date.addingTimeInterval(20 * 86_400), posterData: nil),
        ], signedIn: true)
    }
}

struct UpcomingProvider: TimelineProvider {
    static func rowCount(for family: WidgetFamily) -> Int {
        switch family {
        case .systemSmall:          return 1
        case .systemMedium:         return 3
        case .systemLarge:          return 6
        case .accessoryInline,
             .accessoryRectangular: return 1
        default:                    return 3
        }
    }

    func placeholder(in context: Context) -> UpcomingEntry {
        .placeholder(Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (UpcomingEntry) -> Void) {
        if context.isPreview {
            completion(.placeholder(Date()))
            return
        }
        Task {
            let now = Date()
            let shows = await WidgetData.upcoming(limit: Self.rowCount(for: context.family), on: now)
            completion(UpcomingEntry(date: now, shows: shows, signedIn: WidgetData.isSignedIn))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<UpcomingEntry>) -> Void) {
        Task {
            let now = Date()
            let shows = await WidgetData.upcoming(limit: Self.rowCount(for: context.family), on: now)
            let signedIn = WidgetData.isSignedIn

            // One entry per local midnight so "Today" / "in N days" stays true
            // without a network trip, then a twice-a-day refetch for new adds
            // and date changes.
            var entries = [UpcomingEntry(date: now, shows: shows, signedIn: signedIn)]
            let cal = Calendar.current
            var day = cal.startOfDay(for: now)
            for _ in 0..<14 {
                guard let next = cal.date(byAdding: .day, value: 1, to: day) else { break }
                day = next
                let still = shows.filter { ($0.premiereDate ?? .distantPast) >= day }
                entries.append(UpcomingEntry(date: day, shows: still, signedIn: signedIn))
            }
            let refresh = cal.date(byAdding: .hour, value: 12, to: now) ?? now.addingTimeInterval(43_200)
            completion(Timeline(entries: entries, policy: .after(refresh)))
        }
    }
}

// MARK: - Widget

struct UpcomingPremieresWidget: Widget {
    let kind = "ShowPickerUpcoming"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: UpcomingProvider()) { entry in
            UpcomingView(entry: entry)
        }
        .configurationDisplayName("Upcoming Premieres")
        .description("Your next premieres from Watching and Awaiting, by date.")
        .supportedFamilies([
            .systemSmall, .systemMedium, .systemLarge,
            .accessoryRectangular, .accessoryInline,
        ])
    }
}

// MARK: - Views

struct UpcomingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: UpcomingEntry

    var body: some View {
        if entry.shows.isEmpty {
            switch family {
            case .accessoryInline:
                Label(entry.signedIn ? "No premieres" : "Sign in", systemImage: "tv")
                    .containerBackground(.clear, for: .widget)
            case .accessoryRectangular:
                accessoryEmpty
            default:
                WidgetEmptyState(icon: "calendar.badge.clock",
                                 text: entry.signedIn
                                    ? "No premieres scheduled"
                                    : "Open Show Picker Club and sign in")
            }
        } else {
            switch family {
            case .systemSmall:          small
            case .accessoryInline:      inline
            case .accessoryRectangular: accessoryRect
            case .systemLarge:          list(rows: 6, header: true)
            default:                    list(rows: 3, header: false)
            }
        }
    }

    private var next: WidgetShow { entry.shows[0] }

    // Small — next premiere as a poster card with the date up top.
    private var small: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let d = next.premiereDate {
                Text(WidgetData.relative(d, from: entry.date))
                    .font(.caption.weight(.bold))
                    .padding(.horizontal, 7)
                    .padding(.vertical, 3)
                    .background(.red.opacity(0.85), in: Capsule())
            }
            Spacer(minLength: 0)
            Text(next.title)
                .font(.subheadline.weight(.bold))
                .lineLimit(2)
            if let d = next.premiereDate {
                Text("\(WidgetData.dayLabel(d))\(next.network.map { " · \($0)" } ?? "")")
                    .font(.caption2)
                    .opacity(0.85)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) {
            if let data = next.posterData, let img = UIImage(data: data) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
                    .overlay(
                        LinearGradient(colors: [.black.opacity(0.35), .clear, .black.opacity(0.8)],
                                       startPoint: .top, endPoint: .bottom)
                    )
            } else {
                LinearGradient(colors: [.indigo, .black],
                               startPoint: .top, endPoint: .bottom)
            }
        }
        .widgetURL(next.deepLink)
    }

    // Medium / large — dated rows.
    private func list(rows: Int, header: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if header {
                Label("Upcoming premieres", systemImage: "calendar.badge.clock")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ForEach(entry.shows.prefix(rows)) { show in
                WidgetLink(show: show) { UpcomingRow(show: show, now: entry.date) }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    // Lock screen: one line…
    private var inline: some View {
        Label {
            if let d = next.premiereDate {
                Text("\(next.title) · \(WidgetData.dayLabel(d))")
            } else {
                Text(next.title)
            }
        } icon: {
            Image(systemName: "tv")
        }
        .containerBackground(.clear, for: .widget)
        .widgetURL(next.deepLink)
    }

    // …or the compact rectangle.
    private var accessoryRect: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label("Next Premiere", systemImage: "tv")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(next.title)
                .font(.headline)
                .lineLimit(1)
            if let d = next.premiereDate {
                Text("\(WidgetData.dayLabel(d)) · \(WidgetData.relative(d, from: entry.date))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.clear, for: .widget)
        .widgetURL(next.deepLink)
    }

    private var accessoryEmpty: some View {
        VStack(alignment: .leading, spacing: 1) {
            Label("Next Premiere", systemImage: "tv")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(entry.signedIn ? "No premieres scheduled" : "Sign in on iPhone")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.clear, for: .widget)
    }
}

private struct UpcomingRow: View {
    let show: WidgetShow
    let now: Date

    var body: some View {
        HStack(spacing: 10) {
            PosterThumbImage(data: show.posterData, width: 38, height: 57)
            VStack(alignment: .leading, spacing: 1) {
                Text(show.title)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                if let d = show.premiereDate {
                    Text("\(WidgetData.dayLabel(d)) · \(WidgetData.relative(d, from: now))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let n = show.network {
                    Text(n)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
    }
}
