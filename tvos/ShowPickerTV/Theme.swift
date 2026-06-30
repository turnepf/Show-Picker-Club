import SwiftUI

// Dark, native-tvOS palette. Apple TV apps live on a dark canvas so artwork and
// the colored list/tile accents pop; the brand's list colors carry through.
enum Theme {
    // App canvas — a near-black slate with a hint of the brand's blue ink.
    static let background = Color(red: 0.05, green: 0.06, blue: 0.08)
    // A slightly raised surface for cards/sheets over the canvas.
    static let surface = Color(red: 0.11, green: 0.12, blue: 0.15)
    // Primary text on the dark canvas.
    static let text = Color(red: 0.96, green: 0.97, blue: 0.98)
    // Secondary text — translucent white reads well on dark.
    static let muted = Color.white.opacity(0.6)
    static let orange = Color(red: 0.95, green: 0.61, blue: 0.24) // brand orange, a touch brighter for dark

    // List accent colors (match the web chips), nudged brighter for dark.
    static func listColor(_ list: String) -> Color {
        switch list {
        case "watching": return Color(red: 0.20, green: 0.78, blue: 0.45)
        case "waiting": return Color(red: 0.26, green: 0.60, blue: 0.90)
        case "recommending": return Color(red: 0.66, green: 0.40, blue: 0.85)
        case "next": return orange
        default: return Color(red: 0.45, green: 0.50, blue: 0.62)
        }
    }

    // Deterministic tile color from a title, so a show's fallback tile is
    // stable across launches. Saturated mid-tones that sit well on the dark
    // canvas (used until real poster art lands).
    static func tileColor(for title: String) -> Color {
        let palette: [Color] = [
            Color(red: 0.20, green: 0.42, blue: 0.62),
            Color(red: 0.16, green: 0.52, blue: 0.55),
            Color(red: 0.56, green: 0.30, blue: 0.62),
            Color(red: 0.18, green: 0.55, blue: 0.42),
            Color(red: 0.72, green: 0.34, blue: 0.34),
            Color(red: 0.35, green: 0.40, blue: 0.58),
        ]
        let h = abs(title.hashValue)
        return palette[h % palette.count]
    }
}
