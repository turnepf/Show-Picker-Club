import SwiftUI
import ShowPickerCore

// Group icons, TV rendering. The choices come from the server (validated
// against ShowPickerCore.GroupIcon's curated sets); picking one happens on
// iPhone/iPad — this app only draws it, like everything else here.

// Same named palette as the iOS app's groupTint; duplicated because the
// mapping lands on SwiftUI.Color, which Foundation-only ShowPickerCore
// can't provide.
func groupTintTV(_ name: String?) -> Color {
    switch name {
    case "red": return .red
    case "orange": return .orange
    case "yellow": return .yellow
    case "green": return .green
    case "teal": return .teal
    case "blue": return .blue
    case "indigo": return .indigo
    case "purple": return .purple
    case "pink": return .pink
    case "brown": return .brown
    default: return .gray
    }
}

struct GroupIconBadgeTV: View {
    let icon: String?
    let color: String?
    var size: CGFloat = 56

    var body: some View {
        Image(systemName: icon ?? "person.2.fill")
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(groupTintTV(color).gradient, in: Circle())
    }
}
