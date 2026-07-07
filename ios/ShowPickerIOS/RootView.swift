import SwiftUI
import UIKit

// Picks the layout by device: iPad and Mac (Catalyst) get the purpose-built
// split view (persistent sidebar + detail), iPhone keeps the single-stack
// HomeView. Gated on the device idiom rather than size class so a large iPhone
// in landscape still gets the phone layout, not the tablet one. Catalyst
// reports .pad when scaled to match iPad and .mac when optimized for Mac —
// both belong on the split view.
struct RootView: View {
    var body: some View {
        if UIDevice.current.userInterfaceIdiom == .pad
            || UIDevice.current.userInterfaceIdiom == .mac {
            IPadHomeView()
        } else {
            HomeView()
        }
    }
}
