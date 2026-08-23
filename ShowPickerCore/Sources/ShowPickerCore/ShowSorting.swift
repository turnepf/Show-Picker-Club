import Foundation

// The canonical ordering for a list page, defined once. It was copy-pasted
// into the phone, the TV and the watch, which is three places for the same
// rule to drift apart in — and the "no date sorts last" sentinel is exactly
// the kind of detail one copy loses.
extension Show {
    // rating is a numeric string from the API; unrated sorts as 0.
    public var ratingValue: Double { Double(rating ?? "0") ?? 0 }

    // Soonest premiere first, undated shows sink to the bottom, ties break on
    // the higher rating. The "9999-12-31" sentinel keeps this a plain string
    // compare — the dates are already "yyyy-MM-dd".
    public static func byNextPremiere(_ a: Show, _ b: Show) -> Bool {
        let da = (a.nextSeasonDate?.isEmpty == false) ? a.nextSeasonDate! : "9999-12-31"
        let db = (b.nextSeasonDate?.isEmpty == false) ? b.nextSeasonDate! : "9999-12-31"
        if da != db { return da < db }
        return a.ratingValue > b.ratingValue
    }

    public static func byRating(_ a: Show, _ b: Show) -> Bool {
        a.ratingValue > b.ratingValue
    }

    // The owner's saved drag order. Rows that were never placed carry no
    // `sort_order`, so they sink below the placed ones and settle by rating.
    public static func byManualOrder(_ a: Show, _ b: Show) -> Bool {
        let pa = a.sortOrder ?? Int.max
        let pb = b.sortOrder ?? Int.max
        if pa != pb { return pa < pb }
        return a.ratingValue > b.ratingValue
    }
}

extension Array where Element == Show {
    // Watching and Awaiting lead with the soonest premiere — they're the lists
    // you check for what's coming. The other two order by rating.
    public func sortedForList(_ list: ShowList) -> [Show] {
        (list == .watching || list == .waiting)
            ? sorted(by: Show.byNextPremiere)
            : sorted(by: Show.byRating)
    }

    // What the read-only surfaces (Apple TV, the watch) show: the owner's own
    // drag order when they've set one, and the list default when they haven't.
    // Neither surface lets you reorder, so neither should override the order
    // the owner chose on their phone.
    public func orderedForList(_ list: ShowList) -> [Show] {
        contains(where: { $0.sortOrder != nil })
            ? sorted(by: Show.byManualOrder)
            : sortedForList(list)
    }
}
