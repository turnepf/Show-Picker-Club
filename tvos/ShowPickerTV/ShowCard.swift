import SwiftUI

// A focusable show tile. No poster art yet (the backend stores text + URLs,
// not images), so it renders a gradient card with the title, network, and a
// metadata line (rating + seasons / next-up) laid over the bottom of the card.
// No static shadow — PushButtonStyle grows + lifts the card on focus.
// Built so a `posterURL` can drop in later.
struct ShowCard: View {
    let title: String
    var network: String? = nil
    var rating: String? = nil
    var fullSeries: Bool = false
    // Secondary line, e.g. "3 seasons" or "Next up: 6/1".
    var metaLine: String? = nil

    private static let cardWidth: CGFloat = 320
    private static let cardHeight: CGFloat = 200

    private var hasMeta: Bool {
        (rating?.isEmpty == false) || (metaLine?.isEmpty == false)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [Theme.tileColor(for: title),
                                 Theme.tileColor(for: title).opacity(0.78)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                // Darker scrim along the bottom keeps the title + metadata
                // legible over the lighter part of the gradient.
                .overlay(
                    LinearGradient(
                        colors: [.clear, .black.opacity(0.45)],
                        startPoint: .center,
                        endPoint: .bottom
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                )
                .overlay(alignment: .bottomLeading) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(title)
                            .font(.system(size: 25, weight: .bold))
                            .foregroundColor(.white)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .minimumScaleFactor(0.7)
                        if let network, !network.isEmpty {
                            Text(network)
                                .font(.system(size: 17, weight: .medium))
                                .foregroundColor(.white.opacity(0.8))
                                .lineLimit(1)
                        }
                        if hasMeta {
                            HStack(spacing: 10) {
                                if let rating, !rating.isEmpty {
                                    HStack(spacing: 4) {
                                        Image(systemName: "star.fill")
                                        Text(rating)
                                    }
                                }
                                if let metaLine, !metaLine.isEmpty {
                                    Text(metaLine)
                                        .foregroundColor(.white.opacity(0.85))
                                        .lineLimit(1)
                                }
                            }
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(.top, 1)
                        }
                    }
                    .padding(18)
                }
                .frame(width: Self.cardWidth, height: Self.cardHeight)

            if fullSeries {
                Text("🎬")
                    .font(.system(size: 24))
                    .padding(10)
                    .background(.black.opacity(0.3), in: Circle())
                    .padding(10)
            }
        }
        .frame(width: Self.cardWidth, height: Self.cardHeight)
    }
}
