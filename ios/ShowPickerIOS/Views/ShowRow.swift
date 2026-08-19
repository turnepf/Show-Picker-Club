import SwiftUI
import ShowPickerCore

// The one show row for the whole iOS/iPad app — Trending, a member's lists,
// cross-library search, in-library search, Rate my backlog. Every screen used
// to hand-build its own HStack around PosterThumb, and they had quietly
// drifted apart: some showed the 🎬 series badge, some the "(Movie)" tag, only
// one showed premiere dates, and the backlog screen used a different poster
// size. This is the SwiftUI counterpart of renderShowCard() in
// public/show-renderer.js — same anatomy, same order, same optional lines —
// so a title reads the same on the phone as it does on the web.
//
// A screen's own additions go through `leading` (an accessory before the
// poster, e.g. search's "+") and `extra` (content under the text lines, e.g.
// the backlog's rating tap-row), mirroring the web renderer's prefixHtml and
// extraHtml options.

// What the row needs of a model. Trending, the backlog and the main Show model
// are separate JSON shapes; this is the shared surface between them.
protocol ShowRowDisplayable {
    var rowTitle: String { get }
    var rowPosterUrl: String? { get }
    var rowNetwork: String? { get }
    var rowRating: String? { get }
    var rowIsMovie: Bool { get }
    var rowIsFullSeries: Bool { get }
    var rowSeasonsText: String? { get }
    var rowNextUpRange: String? { get }
}

extension ShowRowDisplayable {
    // Defaults for the leaner shapes: Trending and the backlog carry no
    // premiere or series data, so those lines simply don't render.
    var rowIsFullSeries: Bool { false }
    var rowSeasonsText: String? { nil }
    var rowNextUpRange: String? { nil }
}

extension Show: ShowRowDisplayable {
    var rowTitle: String { title }
    var rowPosterUrl: String? { posterUrl }
    var rowNetwork: String? { network }
    var rowRating: String? { rating }
    var rowIsMovie: Bool { isMovie }
    var rowIsFullSeries: Bool { isFullSeries }
    var rowSeasonsText: String? { seasonsText }
    var rowNextUpRange: String? { nextUpRange }
}

extension PopularShow: ShowRowDisplayable {
    var rowTitle: String { title }
    var rowPosterUrl: String? { posterUrl }
    var rowNetwork: String? { network }
    var rowRating: String? { rating }
    var rowIsMovie: Bool { (movie ?? 0) == 1 }
}

extension AllShow: ShowRowDisplayable {
    var rowTitle: String { title }
    var rowPosterUrl: String? { posterUrl }
    var rowNetwork: String? { network }
    var rowRating: String? { rating }
    var rowIsMovie: Bool { isMovie }
    var rowIsFullSeries: Bool { isFullSeries }
}

// A vibe pick draws as an ordinary show card — the API attaches a live copy's
// artwork and season data for exactly that.
extension VibePick: ShowRowDisplayable {
    var rowTitle: String { title }
    var rowPosterUrl: String? { posterUrl }
    var rowNetwork: String? { network }
    var rowRating: String? { rating }
    var rowIsMovie: Bool { (movie ?? 0) == 1 }
    var rowIsFullSeries: Bool { (fullSeries ?? 0) == 1 }
    var rowSeasonsText: String? {
        guard let n = seasonsReleased, n > 0 else { return nil }
        return "\(n) season\(n == 1 ? "" : "s")"
    }
}

// A favourite actor's show draws as an ordinary show row and pushes the same
// card — it IS one of the member's own copies, just reached via the person.
extension FavoriteActorShow: ShowRowDisplayable {
    var rowTitle: String { title }
    var rowPosterUrl: String? { posterUrl }
    var rowNetwork: String? { network }
    var rowRating: String? { rating }
    var rowIsMovie: Bool { (movie ?? 0) == 1 }
}

extension RateBacklogShow: ShowRowDisplayable {
    var rowTitle: String { title }
    var rowPosterUrl: String? { posterUrl }
    var rowNetwork: String? { nil }
    var rowRating: String? { nil }
    var rowIsMovie: Bool { isMovie }
    var rowSeasonsText: String? {
        guard let n = seasonsReleased, n > 0 else { return nil }
        return "\(n) season\(n == 1 ? "" : "s")"
    }
}

struct ShowRow<Leading: View, Extra: View>: View {
    private let show: any ShowRowDisplayable
    /// Replaces the default network line. Screens use it to say what they add
    /// over a plain list row — which list a copy is on, whose it is.
    private let caption: String?
    /// Archived copies caption in orange; everything else stays secondary.
    private let captionTint: Color?
    private let showRating: Bool
    private let alignment: VerticalAlignment
    private let leading: Leading
    private let extra: Extra

    init(
        _ show: any ShowRowDisplayable,
        caption: String? = nil,
        captionTint: Color? = nil,
        showRating: Bool = true,
        alignment: VerticalAlignment = .center,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder extra: () -> Extra
    ) {
        self.show = show
        self.caption = caption
        self.captionTint = captionTint
        self.showRating = showRating
        self.alignment = alignment
        self.leading = leading()
        self.extra = extra()
    }

    // "Next episode: 6/1 · 3 seasons" — the premiere plus the season count
    // when both are known, either alone otherwise. A premiere date shows on
    // EVERY list: a Loved show that drops a surprise season is exactly what to
    // surface.
    private var seasonLine: String? {
        if show.rowNextUpRange != nil {
            let parts = [show.rowNextUpRange.map { "Next episode: \($0)" }, show.rowSeasonsText].compactMap { $0 }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
        return show.rowSeasonsText
    }

    private var captionText: String? {
        if let caption = caption { return caption.isEmpty ? nil : caption }
        guard let n = show.rowNetwork, !n.isEmpty else { return nil }
        return n
    }

    var body: some View {
        HStack(alignment: alignment, spacing: 12) {
            leading
            PosterThumb(url: show.rowPosterUrl)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(show.rowTitle).font(.body)
                    if show.rowIsFullSeries { Text("🎬") }
                    if show.rowIsMovie {
                        Text("(Movie)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                if let caption = captionText {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(captionTint ?? Color.secondary)
                }
                if let line = seasonLine {
                    Text(line).font(.caption).foregroundStyle(.secondary)
                }
                extra
            }
            Spacer(minLength: 8)
            if showRating, let r = show.rowRating, !r.isEmpty {
                Label(r, systemImage: "star.fill")
                    .font(.caption)
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(.orange)
            }
        }
    }
}

// Convenience inits so the common cases don't have to spell out empty slots.
extension ShowRow where Leading == EmptyView, Extra == EmptyView {
    init(
        _ show: any ShowRowDisplayable,
        caption: String? = nil,
        captionTint: Color? = nil,
        showRating: Bool = true,
        alignment: VerticalAlignment = .center
    ) {
        self.init(show, caption: caption, captionTint: captionTint, showRating: showRating,
                  alignment: alignment,
                  leading: { EmptyView() }, extra: { EmptyView() })
    }
}

extension ShowRow where Leading == EmptyView {
    init(
        _ show: any ShowRowDisplayable,
        caption: String? = nil,
        captionTint: Color? = nil,
        showRating: Bool = true,
        alignment: VerticalAlignment = .center,
        @ViewBuilder extra: () -> Extra
    ) {
        self.init(show, caption: caption, captionTint: captionTint, showRating: showRating,
                  alignment: alignment,
                  leading: { EmptyView() }, extra: extra)
    }
}

extension ShowRow where Extra == EmptyView {
    init(
        _ show: any ShowRowDisplayable,
        caption: String? = nil,
        captionTint: Color? = nil,
        showRating: Bool = true,
        alignment: VerticalAlignment = .center,
        @ViewBuilder leading: () -> Leading
    ) {
        self.init(show, caption: caption, captionTint: captionTint, showRating: showRating,
                  alignment: alignment,
                  leading: leading, extra: { EmptyView() })
    }
}
