import SwiftUI

// Artwork loader backed by ImageCache instead of AsyncImage: AsyncImage rides
// on URLCache, which iOS evicts freely, so posters vanished exactly when the
// member was offline and needed them. This checks the session's in-memory
// cache synchronously (no placeholder flash on scroll-back), then disk, then
// the network — and every download is written through to disk, which is also
// what lets the offline prefetcher warm whole lists ahead of time.
struct CachedImage<Placeholder: View>: View {
    let url: String?
    var contentMode: ContentMode = .fill
    @ViewBuilder var placeholder: () -> Placeholder

    @State private var image: UIImage?

    var body: some View {
        Group {
            if let img = resolved {
                Image(uiImage: img)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            // Reused rows keep their @State: drop the previous URL's image
            // before loading so it can't flash under the new one.
            image = nil
            guard let url, !url.isEmpty, ImageCache.shared.cachedImage(for: url) == nil else { return }
            image = await ImageCache.shared.image(for: url)
        }
    }

    private var resolved: UIImage? {
        guard let url, !url.isEmpty else { return nil }
        return ImageCache.shared.cachedImage(for: url) ?? image
    }
}

// Small TMDB poster thumbnail for list rows (and a larger variant for the
// detail header). Falls back to a film-icon placeholder while loading or when a
// show hasn't been enriched with a poster yet.
struct PosterThumb: View {
    let url: String?
    var width: CGFloat = 44
    var height: CGFloat = 66

    var body: some View {
        CachedImage(url: url) { placeholder }
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
            CachedImage(url: url, contentMode: .fit) {
                ProgressView().tint(.white)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { dismiss() }
        .statusBarHidden()
    }
}
