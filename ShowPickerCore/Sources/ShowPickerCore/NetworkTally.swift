import Foundation

// Per-network show counts for a list footer — the native mirror of the web
// member page's "Netflix (12) · Hulu (3)" line (public/index.html,
// renderShows footer). Counts only shows with a network set, sorted by
// count descending; ties break alphabetically so the line is stable
// between refreshes (the web leaves tie order to insertion, which jitters).
public enum NetworkTally {
    public static func counts(for shows: [Show]) -> [(network: String, count: Int)] {
        var tally: [String: Int] = [:]
        for show in shows {
            guard let network = show.network, !network.isEmpty else { continue }
            tally[network, default: 0] += 1
        }
        return tally.sorted {
            $0.value != $1.value ? $0.value > $1.value : $0.key < $1.key
        }.map { (network: $0.key, count: $0.value) }
    }

    // "Netflix (12) · Hulu (3)", or nil when nothing on the list has a network.
    public static func line(for shows: [Show]) -> String? {
        let counts = counts(for: shows)
        guard !counts.isEmpty else { return nil }
        return counts.map { "\($0.network) (\($0.count))" }.joined(separator: " · ")
    }

    // Whether the visible shows warrant the "🎬 Series Complete" legend line.
    public static func hasFullSeries(_ shows: [Show]) -> Bool {
        shows.contains { $0.isFullSeries }
    }
}
