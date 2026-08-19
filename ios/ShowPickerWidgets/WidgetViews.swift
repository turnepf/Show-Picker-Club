import SwiftUI
import UIKit
import WidgetKit

// Small building blocks shared by the Trending and Upcoming widgets.

// A row/cell wrapper that deep-links to the show's card in the app. Small
// widgets can't hold per-row links (the whole widget is one tap target) —
// those use .widgetURL instead.
struct WidgetLink<Content: View>: View {
    let show: WidgetShow
    @ViewBuilder var content: Content

    var body: some View {
        if let url = show.deepLink {
            Link(destination: url) { content }
        } else {
            content
        }
    }
}

// Poster thumbnail from prefetched data, with a quiet placeholder so rows
// keep their shape when art hasn't been enriched yet.
struct PosterThumbImage: View {
    let data: Data?
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        Group {
            if let data, let img = UIImage(data: data) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
            } else {
                ZStack {
                    Rectangle().fill(.quaternary)
                    Image(systemName: "tv")
                        .font(.system(size: min(width, height) * 0.4))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// One cell of the medium/large poster grids: the art fills the cell with the
// title (and an optional caption) over a bottom legibility gradient — the same
// look as the small widget's full-bleed card, just several to a widget. The
// optional badge is the small widget's red "Tomorrow" capsule. Callers wrap
// each tile in WidgetLink so every poster is its own tap target.
struct PosterGridTile: View {
    let show: WidgetShow
    var badge: String? = nil
    var caption: String? = nil

    var body: some View {
        // Color.clear takes whatever cell the grid hands out; the poster fills
        // and crops to it, so tiles stay uniform whatever the art's aspect.
        Color.clear
            .overlay {
                if let data = show.posterData, let img = UIImage(data: data) {
                    Image(uiImage: img)
                        .resizable()
                        .scaledToFill()
                } else {
                    ZStack {
                        LinearGradient(colors: [.indigo, .black],
                                       startPoint: .top, endPoint: .bottom)
                        Image(systemName: "tv")
                            .font(.title3)
                            .foregroundStyle(.white.opacity(0.5))
                    }
                }
            }
            .overlay(alignment: .bottomLeading) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(show.title)
                        .font(.caption.weight(.bold))
                        .lineLimit(2)
                    if let caption, !caption.isEmpty {
                        Text(caption)
                            .font(.caption2)
                            .opacity(0.85)
                            .lineLimit(1)
                    }
                }
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.top, 14)
                .padding(.bottom, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    LinearGradient(colors: [.clear, .black.opacity(0.8)],
                                   startPoint: .top, endPoint: .bottom)
                )
            }
            .overlay(alignment: .topLeading) {
                if let badge, !badge.isEmpty {
                    Text(badge)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.red.opacity(0.85), in: Capsule())
                        .padding(4)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12))
    }
}

// Poster tiles laid out `columns` across, one row per `columns` shows, each
// tile deep-linking to its show. Clear cells pad a short last row so its
// posters keep the same size as everyone else's.
struct PosterGrid: View {
    let shows: [WidgetShow]
    let columns: Int
    var badge: (WidgetShow) -> String? = { _ in nil }
    var caption: (WidgetShow) -> String? = { _ in nil }

    var body: some View {
        let rows: [[WidgetShow]] = stride(from: 0, to: shows.count, by: columns).map {
            Array(shows[$0..<min($0 + columns, shows.count)])
        }
        VStack(spacing: 8) {
            ForEach(0..<rows.count, id: \.self) { r in
                HStack(spacing: 8) {
                    ForEach(rows[r]) { show in
                        WidgetLink(show: show) {
                            PosterGridTile(show: show, badge: badge(show), caption: caption(show))
                        }
                    }
                    ForEach(0..<(columns - rows[r].count), id: \.self) { _ in
                        Color.clear
                    }
                }
            }
        }
    }
}

// Full-bleed poster card for the small widgets: art as the container
// background, title (and an optional caption line) over a legibility gradient.
struct PosterCard: View {
    let show: WidgetShow
    let caption: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Spacer(minLength: 0)
            Text(show.title)
                .font(.subheadline.weight(.bold))
                .lineLimit(2)
            if let caption, !caption.isEmpty {
                Text(caption)
                    .font(.caption2)
                    .opacity(0.85)
                    .lineLimit(1)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) {
            if let data = show.posterData, let img = UIImage(data: data) {
                Image(uiImage: img)
                    .resizable()
                    .scaledToFill()
                    .overlay(
                        LinearGradient(colors: [.clear, .clear, .black.opacity(0.75)],
                                       startPoint: .top, endPoint: .bottom)
                    )
            } else {
                LinearGradient(colors: [.indigo, .black],
                               startPoint: .top, endPoint: .bottom)
            }
        }
    }
}

// Centered icon + line, used for every empty/signed-out state.
struct WidgetEmptyState: View {
    let icon: String
    let text: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: icon)
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}
