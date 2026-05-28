import SwiftUI

// Works for both a full Show (from a member's list) and a PopularShow (from
// the home shelf), which carry slightly different fields.
enum ShowDetail {
    case show(Show)
    case popular(PopularShow)

    var title: String {
        switch self { case .show(let s): return s.title; case .popular(let p): return p.title }
    }
    var network: String? {
        switch self { case .show(let s): return s.network; case .popular(let p): return p.network }
    }
    var networkUrl: String? {
        switch self { case .show(let s): return s.networkUrl; case .popular(let p): return p.networkUrl }
    }
    var rating: String? {
        switch self { case .show(let s): return s.rating; case .popular(let p): return p.rating }
    }
    var genreList: [String] {
        switch self {
        case .show(let s): return s.genreList
        case .popular(let p): return (p.genres ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
    }
    var hasRealUrl: Bool {
        switch self {
        case .show(let s): return s.hasRealUrl
        case .popular(let p):
            guard let u = p.networkUrl?.lowercased() else { return false }
            if u.isEmpty || u == "#" { return false }
            return !(u.contains("/search") || u.contains("/s?") || u.contains("?q=") || u.contains("?query="))
        }
    }
}

struct ShowDetailView: View {
    let detail: ShowDetail
    @Environment(\.openURL) private var openURL

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                HStack(alignment: .top, spacing: 50) {
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Theme.tileColor(for: detail.title))
                        .overlay(
                            Text(detail.title)
                                .font(.system(size: 40, weight: .bold))
                                .foregroundColor(.white)
                                .multilineTextAlignment(.center)
                                .padding(24)
                                .minimumScaleFactor(0.5)
                        )
                        .frame(width: 420, height: 280)

                    VStack(alignment: .leading, spacing: 24) {
                        Text(detail.title)
                            .font(.system(size: 56, weight: .bold))
                            .foregroundColor(Theme.ink)

                        HStack(spacing: 24) {
                            if let r = detail.rating, !r.isEmpty {
                                Label(r, systemImage: "star.fill").foregroundColor(.yellow)
                            }
                            if let n = detail.network, !n.isEmpty {
                                Text(n).foregroundColor(Theme.ink.opacity(0.7))
                            }
                        }
                        .font(.system(size: 28))

                        if !detail.genreList.isEmpty {
                            Text(detail.genreList.joined(separator: " · "))
                                .font(.system(size: 24))
                                .foregroundColor(.secondary)
                        }

                        if detailIsShow, let s = showValue {
                            metaRows(s)
                        }

                        watchButton
                    }
                    Spacer()
                }

                if detailIsShow, let s = showValue, !s.castMembers.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Cast").font(.system(size: 28, weight: .semibold)).foregroundColor(Theme.ink)
                        Text(s.castMembers.prefix(8).map { $0.name }.joined(separator: ", "))
                            .font(.system(size: 24)).foregroundColor(.secondary)
                    }
                }
            }
            .padding(60)
        }
        .background(Theme.cream.ignoresSafeArea())
    }

    private var detailIsShow: Bool { if case .show = detail { return true }; return false }
    private var showValue: Show? { if case .show(let s) = detail { return s }; return nil }

    @ViewBuilder private func metaRows(_ s: Show) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let by = s.recommendedBy, !by.isEmpty {
                Text("Recommended by \(by)").foregroundColor(Theme.ink.opacity(0.7))
            }
            if let w = s.watchingWith, !w.isEmpty {
                Text("Watching with \(w)").foregroundColor(Theme.ink.opacity(0.7))
            }
            if let notes = s.notes, !notes.isEmpty {
                Text(notes).italic().foregroundColor(.secondary)
            }
        }
        .font(.system(size: 24))
    }

    @ViewBuilder private var watchButton: some View {
        if detail.hasRealUrl, let urlStr = detail.networkUrl, let url = URL(string: urlStr) {
            Button {
                // Best-effort: opens the show in the streaming service's tvOS
                // app via its universal link, or Safari-less fallback handling
                // by the system if the app isn't installed.
                openURL(url)
            } label: {
                Label("Watch on \(detail.network ?? "Streaming")", systemImage: "play.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .padding(.vertical, 8)
            }
            .padding(.top, 12)
        } else {
            Text("No direct link yet")
                .font(.system(size: 22))
                .foregroundColor(.secondary)
                .padding(.top, 12)
        }
    }
}
