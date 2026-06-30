import SwiftUI

// A focusable portrait poster tile — the standard Apple TV card shape. Shows
// the TMDB poster when we have one, falling back to a gradient tile. The title
// + rating/seasons are laid over the bottom of the card on a dark scrim, so the
// card is a single rounded unit (clean rounded focus shadow) and reads the same
// with or without a poster. Built so a `posterURL` can drop in later.
struct ShowCard: View {
    let title: String
    var network: String? = nil
    var rating: String? = nil
    var fullSeries: Bool = false
    // Secondary line, e.g. "3 seasons" or "Next up: 6/1".
    var metaLine: String? = nil
    var posterUrl: String? = nil

    private static let w: CGFloat = 220
    private static let posterH: CGFloat = 330

    private var hasMeta: Bool {
        (rating?.isEmpty == false) || (metaLine?.isEmpty == false)
    }

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            poster

            // Scrim so the title stays legible over bright posters.
            LinearGradient(
                colors: [.clear, .black.opacity(0.25), .black.opacity(0.85)],
                startPoint: .center, endPoint: .bottom
            )

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 21, weight: .bold))
                    .foregroundColor(.white)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .minimumScaleFactor(0.7)
                if let network, !network.isEmpty {
                    Text(network)
                        .font(.system(size: 15, weight: .medium))
                        .foregroundColor(.white.opacity(0.75))
                        .lineLimit(1)
                }
                if hasMeta { metaRow }
            }
            .padding(14)
        }
        .frame(width: Self.w, height: Self.posterH)
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .topTrailing) {
            if fullSeries {
                Text("🎬")
                    .font(.system(size: 22))
                    .padding(8)
                    .background(.black.opacity(0.4), in: Circle())
                    .padding(8)
            }
        }
    }

    @ViewBuilder private var poster: some View {
        if let posterUrl, let url = URL(string: posterUrl) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFill()
                } else {
                    gradientFallback
                }
            }
        } else {
            gradientFallback
        }
    }

    private var gradientFallback: some View {
        LinearGradient(
            colors: [Theme.tileColor(for: title), Theme.tileColor(for: title).opacity(0.78)],
            startPoint: .topLeading, endPoint: .bottomTrailing
        )
    }

    @ViewBuilder private var metaRow: some View {
        HStack(spacing: 10) {
            if let rating, !rating.isEmpty {
                HStack(spacing: 3) {
                    Image(systemName: "star.fill")
                    Text(rating)
                }
                .foregroundColor(Theme.orange)
            }
            if let metaLine, !metaLine.isEmpty {
                Text(metaLine)
                    .foregroundColor(.white.opacity(0.85))
                    .lineLimit(1)
            }
        }
        .font(.system(size: 15, weight: .semibold))
    }
}
