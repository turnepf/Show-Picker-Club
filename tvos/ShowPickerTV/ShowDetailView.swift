import SwiftUI

// Fetches the full show row + cast by id, so the same screen works whether
// you arrived from a member's list or the popular shelf. Shows the passed-in
// title/network/rating instantly, then fills in genres, notes, recommender,
// dates, cast, and the real watch URL once loaded.
struct ShowDetailView: View {
    let id: Int
    let initialTitle: String
    let initialNetwork: String?
    let initialRating: String?

    @State private var show: Show?
    @State private var cast: [Actor] = []
    @State private var openFailed = false
    @Environment(\.openURL) private var openURL

    private var title: String { show?.title ?? initialTitle }
    private var network: String? { show?.network ?? initialNetwork }
    private var rating: String? { show?.rating ?? initialRating }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                HStack(alignment: .top, spacing: 50) {
                    RoundedRectangle(cornerRadius: 18)
                        .fill(Theme.tileColor(for: title))
                        .overlay(
                            VStack(spacing: 8) {
                                Text(title)
                                    .font(.system(size: 40, weight: .bold))
                                    .foregroundColor(.white)
                                    .multilineTextAlignment(.center)
                                if let network, !network.isEmpty {
                                    Text("on \(network)")
                                        .font(.system(size: 24, weight: .medium))
                                        .foregroundColor(.white.opacity(0.85))
                                }
                            }
                            .padding(24)
                            .minimumScaleFactor(0.5)
                        )
                        .frame(width: 420, height: 280)

                    VStack(alignment: .leading, spacing: 22) {
                        Text(title)
                            .font(.system(size: 54, weight: .bold))
                            .foregroundColor(Theme.ink)

                        HStack(spacing: 24) {
                            if let rating, !rating.isEmpty {
                                Label(rating, systemImage: "star.fill").foregroundColor(.orange)
                            }
                            if let network, !network.isEmpty {
                                Text(network).foregroundColor(Theme.ink.opacity(0.7))
                            }
                            if let s = show, s.isMovie {
                                Text("Movie").foregroundColor(Theme.ink.opacity(0.5))
                            }
                            if let s = show, s.isFullSeries {
                                Text("🎬 Complete")
                            }
                        }
                        .font(.system(size: 26))

                        if let s = show, !s.genreList.isEmpty {
                            Text(s.genreList.joined(separator: " · "))
                                .font(.system(size: 24))
                                .foregroundColor(.secondary)
                        }

                        if let s = show { metaRows(s) }

                        watchButton
                    }
                    Spacer()
                }

                if !cast.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Cast")
                            .font(.system(size: 30, weight: .semibold))
                            .foregroundColor(Theme.ink)
                        Text(cast.prefix(10).map { $0.name }.joined(separator: ", "))
                            .font(.system(size: 24))
                            .foregroundColor(.secondary)
                    }
                }
            }
            .padding(60)
        }
        .background(Theme.cream.ignoresSafeArea())
        .task { await load() }
    }

    @ViewBuilder private func metaRows(_ s: Show) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let by = s.recommendedBy, !by.isEmpty {
                Text("Recommended by \(by)").foregroundColor(Theme.ink.opacity(0.7))
            }
            if let dates = seasonDates(s) {
                Text(dates).foregroundColor(Theme.ink.opacity(0.7))
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

    private func seasonDates(_ s: Show) -> String? {
        let start = s.nextSeasonDate, end = s.seasonEndDate
        if let start, !start.isEmpty, let end, !end.isEmpty { return "Next up: \(start) – \(end)" }
        if let start, !start.isEmpty { return "Next up: \(start)" }
        if let end, !end.isEmpty { return "Through \(end)" }
        return nil
    }

    @ViewBuilder private var watchButton: some View {
        if let s = show, s.hasRealUrl, let urlStr = s.networkUrl, let url = URL(string: urlStr) {
            Button {
                openURL(url) { accepted in
                    openFailed = !accepted
                }
            } label: {
                Label("Watch on \(network ?? "Streaming")", systemImage: "play.fill")
                    .font(.system(size: 30, weight: .semibold))
                    .padding(.vertical, 8)
            }
            .padding(.top, 12)

            if openFailed {
                Text("Couldn't open the app on this device — try the \(network ?? "streaming") app directly.")
                    .font(.system(size: 20))
                    .foregroundColor(.secondary)
            }
        } else if show != nil {
            Text("No direct link yet")
                .font(.system(size: 22))
                .foregroundColor(.secondary)
                .padding(.top, 12)
        }
    }

    private func load() async {
        async let detailTask = try? API.showDetail(id: id)
        async let castTask = try? API.actors(showId: id)
        if let s = await detailTask { show = s }
        cast = (await castTask) ?? []
    }
}
