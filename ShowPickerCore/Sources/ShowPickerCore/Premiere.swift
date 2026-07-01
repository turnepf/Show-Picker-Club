import Foundation

// Shared "next premiere" logic used by the complication (and available to the
// apps). A premiere is the start of a show's next season, taken from the
// `next_season_date` the API already supplies. We only consider the lists you
// actively track upcoming episodes on — Watching and Awaiting — and skip
// archived rows.
extension Show {
    // `next_season_date` parsed as a calendar day. Stored as "yyyy-MM-dd".
    public var nextSeasonDay: Date? {
        guard let s = nextSeasonDate, !s.isEmpty else { return nil }
        return Premiere.dayFormatter.date(from: s)
    }
}

public enum Premiere {
    // Fixed-format, locale-independent parser for the API's "yyyy-MM-dd".
    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    // The soonest show whose next season premieres on or after `day`, across the
    // Watching + Awaiting lists. Ties break on higher rating. nil if nothing is
    // scheduled.
    public static func next(from shows: [Show], on day: Date, calendar: Calendar = .current) -> Show? {
        let today = calendar.startOfDay(for: day)
        let upcoming = shows.compactMap { s -> (show: Show, date: Date)? in
            guard !s.isArchived,
                  s.list == ShowList.watching.rawValue || s.list == ShowList.waiting.rawValue,
                  let d = s.nextSeasonDay,
                  calendar.startOfDay(for: d) >= today
            else { return nil }
            return (s, calendar.startOfDay(for: d))
        }
        return upcoming.sorted { a, b in
            if a.date != b.date { return a.date < b.date }
            return (Double(a.show.rating ?? "0") ?? 0) > (Double(b.show.rating ?? "0") ?? 0)
        }.first?.show
    }
}
