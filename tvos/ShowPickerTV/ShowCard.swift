import SwiftUI

// A focusable portrait poster tile — the standard Apple TV card shape. Shows the
// TMDB poster when we have one, falling back to a gradient tile. Kept minimal:
// title + network, plus one optional line (e.g. "Next up: …" on Watching/Waiting,
// or a pick's reason). Everything else — rating, seasons, cast — lives on the
// detail screen. Text sits over the bottom on a scrim, so the card is a single
// rounded unit that reads the same with or without a poster.
struct ShowCard: View {
    let title: String
    var network: String? = nil
    var line: String? = nil
    var fullSeries: Bool = false
    var posterUrl: String? = nil

    private static let w: CGFloat = 220
    private static let posterH: CGFloat = 330

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            poster

            // Scrim so the text stays legible over bright posters.
            LinearGradient(
                colors: [.clear, .black.opacity(0.35), .black.opacity(0.9)],
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
                if let line, !line.isEmpty {
                    Text(line)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(.white.opacity(0.9))
                        .lineLimit(1)
                }
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
}
