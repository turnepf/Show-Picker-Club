import SwiftUI

// Pill-shaped control style for the detail screen's buttons — the Watch button,
// the four list chips, Archive.
//
// It exists because neither system style read correctly on a TV. The plain
// default gives an unfocused button no plate at all, so "Watch on Netflix" was
// dim text floating on the dark canvas until you focused it. `.bordered` has the
// opposite problem: its focused state is a near-white plate, and our labels were
// pinned to Theme.text (0.96 white), so focusing a list chip turned it white on
// white. Owning both states here is the only way to guarantee contrast in each.
//
// Labels must NOT set their own foreground color — this style drives it, which
// is what lets the text flip dark against the focused plate.
struct ChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        FocusAware(configuration: configuration)
    }

    private struct FocusAware: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isFocused) private var focused: Bool

        var body: some View {
            configuration.label
                .foregroundColor(focused ? Theme.background : Theme.text)
                .padding(.horizontal, 28)
                .padding(.vertical, 14)
                .background(
                    Capsule().fill(focused ? Theme.text : Theme.surface)
                )
                .overlay(
                    // A visible rim unfocused, so the control reads as a button
                    // before it's selected rather than as a line of text.
                    Capsule().stroke(Theme.text.opacity(focused ? 0 : 0.28), lineWidth: 2)
                )
                .scaleEffect(configuration.isPressed ? 1.02 : (focused ? 1.05 : 1.0))
                .shadow(color: .black.opacity(focused ? 0.5 : 0),
                        radius: focused ? 14 : 0, x: 0, y: focused ? 8 : 0)
                .animation(.easeOut(duration: 0.18), value: focused)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .zIndex(focused ? 1 : 0)
        }
    }
}

// Focus effect for cards. The system `.card` style swaps in its own plate when
// focused — which squared off our rounded corners and shifted the bottom-left
// text — so instead we keep the card's own shape and just grow + lift it on
// focus (the standard Apple TV "pop"), with a small settle on click.
struct PushButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        FocusAware(configuration: configuration)
    }

    private struct FocusAware: View {
        let configuration: ButtonStyle.Configuration
        @Environment(\.isFocused) private var focused: Bool

        var body: some View {
            configuration.label
                .scaleEffect(scale)
                .shadow(color: .black.opacity(focused ? 0.5 : 0),
                        radius: focused ? 16 : 0, x: 0, y: focused ? 10 : 0)
                .animation(.easeOut(duration: 0.18), value: focused)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .zIndex(focused ? 1 : 0)
        }

        private var scale: CGFloat {
            if configuration.isPressed { return 1.03 }
            return focused ? 1.06 : 1.0
        }
    }
}
