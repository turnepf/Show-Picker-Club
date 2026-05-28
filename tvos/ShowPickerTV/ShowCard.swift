import SwiftUI

// A focusable show tile. No poster art yet (the backend stores text + URLs,
// not images), so v1 renders a colored card with the title. Designed so a
// `posterURL` can drop in later without changing callers.
struct ShowCard: View {
    let title: String
    let subtitle: String?
    var rating: String? = nil
    var badge: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topTrailing) {
                RoundedRectangle(cornerRadius: 14)
                    .fill(Theme.tileColor(for: title))
                    .overlay(
                        Text(title)
                            .font(.system(size: 26, weight: .bold))
                            .foregroundColor(.white)
                            .multilineTextAlignment(.center)
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
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.system(size: 22, weight: .semibold))
                    .lineLimit(1)
                    .foregroundColor(Theme.ink)
                HStack(spacing: 8) {
                    if let rating, !rating.isEmpty {
                        Text("★ \(rating)").foregroundColor(.yellow.opacity(0.9))
                    }
                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle).foregroundColor(.secondary).lineLimit(1)
                    }
                }
                .font(.system(size: 18))
            }
            .frame(width: 300, alignment: .leading)
            .padding(.top, 10)
        }
    }
}
