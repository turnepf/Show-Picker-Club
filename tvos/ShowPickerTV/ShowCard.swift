import SwiftUI

// A focusable show tile. No poster art yet (the backend stores text + URLs,
// not images), so v1 renders a colored card with "Title on Network" and the
// rating below. Built so a `posterURL` can drop in later.
struct ShowCard: View {
    let title: String
    var network: String? = nil
    var rating: String? = nil
    var badge: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topTrailing) {
                RoundedRectangle(cornerRadius: 14)
                    .fill(Theme.tileColor(for: title))
                    .overlay(
                        VStack(spacing: 6) {
                            Text(title)
                                .font(.system(size: 26, weight: .bold))
                                .foregroundColor(.white)
                                .multilineTextAlignment(.center)
                            if let network, !network.isEmpty {
                                Text("on \(network)")
                                    .font(.system(size: 18, weight: .medium))
                                    .foregroundColor(.white.opacity(0.85))
                                    .multilineTextAlignment(.center)
                            }
                        }
                        .padding(16)
                        .minimumScaleFactor(0.6)
                    )
                    .frame(width: 300, height: 200)

                if let badge {
                    Text(badge)
                        .font(.system(size: 28))
                        .padding(8)
                }
            }
            // Rating only — no repeated title.
            if let rating, !rating.isEmpty {
                Text("★ \(rating)")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.orange)
                    .frame(width: 300, alignment: .leading)
            } else {
                Color.clear.frame(width: 300, height: 22)
            }
        }
    }
}
