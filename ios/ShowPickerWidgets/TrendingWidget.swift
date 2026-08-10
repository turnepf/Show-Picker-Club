import WidgetKit
import SwiftUI
import ShowPickerCore

// MARK: - Timeline

struct TrendingEntry: TimelineEntry {
    let date: Date
    let shows: [WidgetShow]

    static func placeholder(_ date: Date) -> TrendingEntry {
        TrendingEntry(date: date, shows: [
            WidgetShow(id: 1, title: "House of the Dragon", network: "HBO Max", rating: "8.4",
                       membersText: "Watching: Patrick, Whitt", eventDate: nil, eventKind: nil, posterData: nil),
            WidgetShow(id: 2, title: "Slow Horses", network: "Apple TV+", rating: "8.2",
                       membersText: "Watching: Patrick", eventDate: nil, eventKind: nil, posterData: nil),
            WidgetShow(id: 3, title: "The Bear", network: "Hulu", rating: "8.5",
                       membersText: "Watching: Whitt", eventDate: nil, eventKind: nil, posterData: nil),
        ])
    }
}

struct TrendingProvider: TimelineProvider {
    // How many rows each family can show; also caps the poster downloads.
    static func rowCount(for family: WidgetFamily) -> Int {
        switch family {
        case .systemSmall:      return 1
        case .systemMedium:     return 3
        case .systemLarge:      return 5
        case .systemExtraLarge: return 8
        default:                return 3
        }
    }

    func placeholder(in context: Context) -> TrendingEntry {
        .placeholder(Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (TrendingEntry) -> Void) {
        if context.isPreview {
            completion(.placeholder(Date()))
            return
        }
        Task {
            let shows = await WidgetData.trending(limit: Self.rowCount(for: context.family))
            completion(TrendingEntry(date: Date(), shows: shows))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TrendingEntry>) -> Void) {
        Task {
            let now = Date()
            let shows = await WidgetData.trending(limit: Self.rowCount(for: context.family))
            // Trending is a 30-day rolling ranking — it drifts slowly. Refresh a
            // few times a day; the app also nudges WidgetCenter on auth changes.
            let refresh = now.addingTimeInterval(shows.isEmpty ? 3_600 : 6 * 3_600)
            completion(Timeline(entries: [TrendingEntry(date: now, shows: shows)],
                                policy: .after(refresh)))
        }
    }
}

// MARK: - Widget

struct TrendingWidget: Widget {
    let kind = "ShowPickerTrending"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TrendingProvider()) { entry in
            TrendingView(entry: entry)
        }
        .configurationDisplayName("Trending")
        .description("What the club is picking up right now.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}

// MARK: - Views

struct TrendingView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TrendingEntry

    var body: some View {
        if entry.shows.isEmpty {
            WidgetEmptyState(icon: "flame", text: "Nothing trending yet")
        } else {
            switch family {
            case .systemSmall:      small
            case .systemMedium:     medium
            case .systemLarge:      list(rows: 5, header: true)
            case .systemExtraLarge: grid
            default:                medium
            }
        }
    }

    // Small — the #1 show as a full-bleed poster card.
    private var small: some View {
        let top = entry.shows[0]
        return PosterCard(show: top, caption: top.network)
            .widgetURL(top.deepLink)
    }

    // Medium — top three as poster columns.
    private var medium: some View {
        HStack(alignment: .top, spacing: 10) {
            ForEach(entry.shows.prefix(3)) { show in
                WidgetLink(show: show) {
                    VStack(spacing: 4) {
                        PosterThumbImage(data: show.posterData, width: 62, height: 93)
                        Text(show.title)
                            .font(.caption2.weight(.medium))
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .padding(.vertical, 2)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    // Large — header + rows.
    private func list(rows: Int, header: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if header {
                Label("Trending at the club", systemImage: "flame")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            ForEach(entry.shows.prefix(rows)) { show in
                WidgetLink(show: show) { TrendingRow(show: show) }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }

    // Extra large (iPad / Mac) — two columns of rows.
    private var grid: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Trending at the club", systemImage: "flame")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            let items = Array(entry.shows.prefix(8))
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible())],
                      alignment: .leading, spacing: 8) {
                ForEach(items) { show in
                    WidgetLink(show: show) { TrendingRow(show: show) }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

private struct TrendingRow: View {
    let show: WidgetShow

    var body: some View {
        HStack(spacing: 10) {
            PosterThumbImage(data: show.posterData, width: 38, height: 57)
            VStack(alignment: .leading, spacing: 1) {
                Text(show.title)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                Text([show.network, show.rating.map { "★ \($0)" }]
                        .compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                if let m = show.membersText {
                    Text(m)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
    }
}
