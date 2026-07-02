import SwiftUI
import UIKit

// Picks the layout by device: iPad gets the purpose-built split view
// (persistent sidebar + detail), iPhone keeps the single-stack HomeView. Gated
// on the device idiom rather than size class so a large iPhone in landscape
// still gets the phone layout, not the tablet one.
struct RootView: View {
    var body: some View {
        if UIDevice.current.userInterfaceIdiom == .pad {
            IPadHomeView()
        } else {
            HomeView()
        }
    }
}
