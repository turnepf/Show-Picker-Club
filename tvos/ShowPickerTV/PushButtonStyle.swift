import SwiftUI

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
                .shadow(color: .black.opacity(focused ? 0.35 : 0),
                        radius: focused ? 22 : 0, x: 0, y: focused ? 14 : 0)
                .animation(.easeOut(duration: 0.18), value: focused)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
        }

        private var scale: CGFloat {
            if configuration.isPressed { return 1.04 }
            return focused ? 1.08 : 1.0
        }
    }
}
