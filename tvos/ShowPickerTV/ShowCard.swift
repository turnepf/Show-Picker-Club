import SwiftUI

// A focusable portrait poster tile, Apple-TV style: the poster fills the card,
// the next-up date sits top-left and the network logo top-right (both white),
// and the title appears centered at the bottom only when the card is focused —
// or always when there's no poster yet (so the gradient fallback is readable).
// Everything else lives on the detail screen.
struct ShowCard: View {
    let title: String
    var subtitle: String? = nil          // shown under the title (e.g. a pick's reason)
    var nextUp: String? = nil            // top-left, e.g. "6/29 – 7/13"
    var networkLogoUrl: String? = nil    // top-right
    var posterUrl: String? = nil

    @Environment(\.isFocused) private var isFocused: Bool

    private static let w: CGFloat = 220
    private static let posterH: CGFloat = 330

    // Title overlays the poster only on focus; without a poster it's always on
    // (it's the only thing identifying the gradient tile).
    private var showsTitle: Bool { posterUrl == nil || isFocused }

    var body: some View {
        poster
            .frame(width: Self.w, height: Self.posterH)
            .overlay(alignment: .topLeading) { nextUpBadge }
            .overlay(alignment: .topTrailing) { logo }
            .overlay(alignment: .bottom) { if showsTitle { titleBlock } }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    @ViewBuilder private var nextUpBadge: some View {
        if let nextUp, !nextUp.isEmpty {
            Text(nextUp)
                .font(.system(size: 16, weight: .semibold))
                .foregroundColor(.white)
                .shadow(color: .black.opacity(0.7), radius: 4, y: 1)
                .padding(12)
        }
    }

    @ViewBuilder private var logo: some View {
        if let networkLogoUrl, let u = URL(string: networkLogoUrl) {
            AsyncImage(url: u) { phase in
                if let image = phase.image {
                    image.resizable().scaledToFit()
                } else {
                    Color.clear
                }
            }
            .frame(maxWidth: 64, maxHeight: 24, alignment: .topTrailing)
            .shadow(color: .black.opacity(0.6), radius: 4, y: 1)
            .padding(12)
        }
    }

    private var titleBlock: some View {
        VStack(spacing: 3) {
            Text(title)
                .font(.system(size: 19, weight: .bold))
                .foregroundColor(.white)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.7)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(.white.opacity(0.85))
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 24)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(
            LinearGradient(colors: [.clear, .black.opacity(0.85)],
                           startPoint: .top, endPoint: .bottom)
        )
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
