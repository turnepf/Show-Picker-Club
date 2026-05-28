import SwiftUI

// Palette echoing the web app.
enum Theme {
    static let cream = Color(red: 0.98, green: 0.96, blue: 0.92)
    static let ink = Color(red: 0.17, green: 0.24, blue: 0.31)   // #2C3E50
    static let orange = Color(red: 0.90, green: 0.49, blue: 0.13) // #E67E22
    // Readable muted text on the cream background. Don't use SwiftUI's
    // .secondary here — on tvOS it's a light translucent color meant for
    // dark UIs, so it vanishes against cream.
    static let muted = Color(red: 0.17, green: 0.24, blue: 0.31).opacity(0.6)

    // List accent colors (match the web chips).
    static func listColor(_ list: String) -> Color {
        switch list {
        case "watching": return Color(red: 0.15, green: 0.68, blue: 0.38)
        case "waiting": return Color(red: 0.16, green: 0.50, blue: 0.73)
        case "recommending": return Color(red: 0.56, green: 0.27, blue: 0.68)
        case "next": return orange
        default: return ink
        }
    }

    // Deterministic tile color from a title, so a show's fallback tile is
    // stable across launches.
    static func tileColor(for title: String) -> Color {
        let palette: [Color] = [
            Color(red: 0.17, green: 0.24, blue: 0.31),
            Color(red: 0.16, green: 0.50, blue: 0.73),
            Color(red: 0.56, green: 0.27, blue: 0.68),
            Color(red: 0.15, green: 0.55, blue: 0.48),
            Color(red: 0.70, green: 0.30, blue: 0.30),
            Color(red: 0.35, green: 0.40, blue: 0.55),
        ]
        let h = abs(title.hashValue)
        return palette[h % palette.count]
    }
}
