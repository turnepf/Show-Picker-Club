import SwiftUI

// One-tap list promotions, mirroring the web's quick-action buttons that keep
// the four lists honest:
//   Watching      → "Watched" (Recommending) / "Season Done" (Waiting)
//   Waiting       → "Watching"
//   Recommending  → "Watching"
//   Up Next       → "Start watching"
// Used by MemberView (leading swipe actions) and ShowDetailView (a Move
// section), so the same moves work with or without the gesture.
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
            ListPromotion(label: "Watched", detailLabel: "Watched it → Recommending",
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
