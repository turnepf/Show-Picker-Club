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
