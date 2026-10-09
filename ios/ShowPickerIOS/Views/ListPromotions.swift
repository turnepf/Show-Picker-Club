import SwiftUI

// One-tap list promotions, mirroring the web's quick-action buttons that keep
// the four lists honest:
//   Watching      → "Watched" (Loved) / "Season Done" (Waiting)
//   Waiting       → "Watching"
//   Loved         → "Watching"
//   Next Up       → "Start watching"
// Used by ShowDetailView's Move section. (MemberView's rows used to carry
// these as swipe actions; since 2026-10 a long-press there offers every other
// list instead, and a sideways swipe changes list.)
struct ListPromotion: Identifiable {
    let id = UUID()
    let label: String        // short label for swipe actions
    let detailLabel: String  // longer label for the detail-screen buttons
    let systemImage: String
    let target: ShowList
    let tint: Color
}

func listPromotions(for list: ShowList) -> [ListPromotion] {
    switch list {
    case .watching:
        return [
            ListPromotion(label: "Watched", detailLabel: "Watched it → Loved",
                          systemImage: "checkmark.circle.fill", target: .recommending, tint: .purple),
            ListPromotion(label: "Season Done", detailLabel: "Season done → Awaiting",
                          systemImage: "hourglass", target: .waiting, tint: .blue),
        ]
    case .waiting:
        return [ListPromotion(label: "Watching", detailLabel: "Back to Watching",
                              systemImage: "play.circle.fill", target: .watching, tint: .green)]
    case .recommending:
        return [ListPromotion(label: "Watching", detailLabel: "Back to Watching",
                              systemImage: "play.circle.fill", target: .watching, tint: .green)]
    case .next:
        return [ListPromotion(label: "Start", detailLabel: "Start watching",
                              systemImage: "play.circle.fill", target: .watching, tint: .green)]
    }
}

// Each list's SF Symbol — the iPad sidebar's list rows and the member page's
// long-press "Move to…" menu.
extension ShowList {
    var menuSymbol: String {
        switch self {
        case .watching:     return "play.circle"
        case .waiting:      return "hourglass"
        case .recommending: return "hand.thumbsup"
        case .next:         return "text.badge.plus"
        }
    }
}
