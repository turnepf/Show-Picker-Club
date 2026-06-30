import SwiftUI

// A focusable portrait poster tile — the standard Apple TV card shape. Shows
// the TMDB poster when we have one, falling back to a gradient tile with the
// title for shows that haven't been enriched yet. Title + rating/seasons sit
// below the art. PushButtonStyle grows + lifts it on focus.
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

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ZStack(alignment: .topTrailing) {
                poster
                    .frame(width: Self.w, height: Self.posterH)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

                if fullSeries {
                    Text("🎬")
                        .font(.system(size: 22))
                        .padding(8)
                        .background(.black.opacity(0.35), in: Circle())
                        .padding(8)
                }
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(Theme.text)
                    .lineLimit(1)
                metaRow
            }
            .frame(width: Self.w, alignment: .leading)
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
        .overlay(
            Text(title)
                .font(.system(size: 22, weight: .bold))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .minimumScaleFactor(0.6)
                .padding(16)
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
                    .foregroundColor(Theme.muted)
                    .lineLimit(1)
            }
        }
        .font(.system(size: 16, weight: .medium))
        .frame(height: 20, alignment: .leading)
    }
}
