import SwiftUI

// One type-ahead result under the Title field in Add Show / Suggest: poster
// thumb, canonical name, year and TV/Movie tag. Tapping it (the parent's
// Button) pins the exact TMDB entry so enrichment can't mismatch.
struct TitleHitRow: View {
    let hit: TitleHit

    var body: some View {
        HStack(spacing: 10) {
            PosterThumb(url: hit.posterUrl, width: 32, height: 48)
            VStack(alignment: .leading, spacing: 1) {
                Text(hit.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                Text(hit.metaText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "arrow.up.left")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }
}
