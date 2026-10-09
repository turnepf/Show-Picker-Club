import Foundation

// The member's calendar, in one place: every dated thing on the Watching and
// Awaiting lists, soonest first. Two dates per show can be known — the next
// episode to air (`next_season_date`, despite the name: it is TMDB's
// `next_episode_to_air`) and the end of the current season
// (`season_end_date`) — and both are calendar events, so both count here.
// The next episode is only a *premiere* when it opens its season, i.e. it falls
// on `season_premiere_date`; mid-season it is just the next episode, and
// calling it "Premieres" put shows that started weeks ago back on the calendar
// as if they were new. The
// in-app Calendar screen and the Upcoming widget both read this, which is what
// keeps them showing the same "next" item.
extension Show {
    // `next_season_date` parsed as a calendar day. Stored as "yyyy-MM-dd".
    public var nextSeasonDay: Date? { ShowCalendar.day(nextSeasonDate) }

    // `season_end_date` — the finale of the season currently airing.
    public var seasonEndDay: Date? { ShowCalendar.day(seasonEndDate) }
}

public enum ShowCalendar {
    // String-backed + Codable so the widgets' last-good snapshot (rendered
    // when the device is offline) can round-trip through JSON on disk.
    public enum Kind: String, Codable, Sendable, Hashable {
        case premiere
        case finale
        case episode    // the next episode of a season already on air

        // Row caption in the Calendar screen ("Premieres Tue, Mar 3").
        public var label: String {
            switch self {
            case .premiere: return "Premieres"
            case .finale:   return "Finale"
            case .episode:  return "New episode"
            }
        }

        // Standalone noun, for widget headers and badges.
        public var noun: String {
            switch self {
            case .premiere: return "Premiere"
            case .finale:   return "Finale"
            case .episode:  return "Episode"
            }
        }

        // Which wins when two dates for one show land on the same day: a
        // premiere is the bigger news than a finale, and a finale is more
        // specific than "the next episode" (the last episode IS the finale).
        var tieRank: Int {
            switch self {
            case .premiere: return 0
            case .finale:   return 1
            case .episode:  return 2
            }
        }
    }

    // One dated thing on the calendar.
    public struct DatedShow: Identifiable, Sendable, Hashable {
        public let show: Show
        public let date: Date
        public let day: String          // the raw "yyyy-MM-dd", for grouping
        public let kind: Kind

        public init(show: Show, date: Date, day: String, kind: Kind) {
            self.show = show
            self.date = date
            self.day = day
            self.kind = kind
        }

        // A show can contribute either date, so the kind rides along in the id.
        public var id: String { "\(show.id)-\(kind.rawValue)" }
        public var label: String { kind.label }
    }

    // Fixed-format, locale-independent parser for the API's "yyyy-MM-dd".
    // Deliberately left on the device time zone: these are calendar days, not
    // instants, and everything downstream compares and formats them against
    // `Calendar.current`.
    static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    public static func day(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return dayFormatter.date(from: s)
    }

    // Every dated thing from `day` forward, soonest first.
    //
    // One row per show — whichever of its two dates comes first. A show with
    // both a premiere and a finale ahead of it appeared twice, which reads as a
    // duplicate rather than as two facts. Archived rows and the two undated
    // lists (Loved, Next Up) carry no dates worth showing.
    public static func upcoming(from shows: [Show],
                                on day: Date = Date(),
                                calendar: Calendar = .current) -> [DatedShow] {
        let today = calendar.startOfDay(for: day)
        var out: [DatedShow] = []
        for show in shows where !show.isArchived {
            guard show.list == ShowList.watching.rawValue || show.list == ShowList.waiting.rawValue else { continue }
            var candidates: [DatedShow] = []
            if let raw = show.nextSeasonDate, let date = ShowCalendar.day(raw),
               calendar.startOfDay(for: date) >= today {
                let kind: Kind = raw == show.seasonPremiereDate ? .premiere : .episode
                candidates.append(DatedShow(show: show, date: calendar.startOfDay(for: date),
                                            day: raw, kind: kind))
            }
            if let raw = show.seasonEndDate, let date = ShowCalendar.day(raw),
               calendar.startOfDay(for: date) >= today {
                candidates.append(DatedShow(show: show, date: calendar.startOfDay(for: date),
                                            day: raw, kind: .finale))
            }
            // Two dates on the same day are the same event told two ways —
            // `min` breaks the tie on kind (premiere, then finale, then episode).
            if let soonest = candidates.min(by: {
                $0.date == $1.date ? $0.kind.tieRank < $1.kind.tieRank : $0.date < $1.date
            }) {
                out.append(soonest)
            }
        }
        return out.sorted { $0.date == $1.date ? $0.show.title < $1.show.title : $0.date < $1.date }
    }

    // The single next thing on the calendar; nil when nothing is dated.
    public static func next(from shows: [Show],
                            on day: Date = Date(),
                            calendar: Calendar = .current) -> DatedShow? {
        upcoming(from: shows, on: day, calendar: calendar).first
    }
}
