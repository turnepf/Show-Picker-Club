import SwiftUI

// Small TMDB poster thumbnail for list rows (and a larger variant for the
// detail header). Falls back to a film-icon placeholder while loading or when a
// show hasn't been enriched with a poster yet.
struct PosterThumb: View {
    let url: String?
    var width: CGFloat = 44
    var height: CGFloat = 66

    var body: some View {
        Group {
            if let url, let u = URL(string: url) {
                AsyncImage(url: u) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: width, height: height)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private var placeholder: some View {
        ZStack {
            Color(.secondarySystemFill)
            Image(systemName: "film")
                .font(.system(size: width * 0.4))
                .foregroundStyle(.secondary)
        }
    }
}

// Full-screen poster viewer: the detail screen presents this when the poster
// thumbnail is tapped; tapping anywhere sends it back to the thumbnail.
struct FullScreenPoster: View {
    let url: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let u = URL(string: url) {
                AsyncImage(url: u) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFit()
                    } else {
                        ProgressView().tint(.white)
                    }
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { dismiss() }
        .statusBarHidden()
    }
}
