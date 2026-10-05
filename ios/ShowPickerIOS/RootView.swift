import SwiftUI
import UIKit

// Picks the layout: the split view (persistent sidebar + detail) when there is
// room for one, the single-stack HomeView when there isn't.
//
// iPad and Mac (Catalyst) always get the split view — NavigationSplitView
// collapses on its own in a narrow iPad Split View, and that is the behavior
// those members already have. Catalyst reports .pad when scaled to match iPad
// and .mac when optimized for Mac; both belong on the split view.
//
// Everything else is decided by size class, because iPhone Duo is one device
// with two answers: the outer display is an ordinary iPhone (compact width),
// the inner one is regular x regular in every pose. Requiring *both* to be
// regular keeps a large iPhone in landscape (regular x compact) on the phone
// layout, which is what the old idiom check was protecting.
//
// Folding or unfolding mid-session swaps one view tree for the other, which
// would throw away everything either one holds in @State. Two things stop
// that from costing the member anything:
//   - The navigation path lives here, in the phone layout's shape, and both
//     layouts read and write it — so you land on the same screen.
//   - While a sheet is up (an edit in progress, the login flow), the swap
//     waits until it closes. Dismissing a half-typed edit because the phone
//     was opened would be worse than a stretched layout for a few seconds.
struct RootView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass

    @State private var path: [Route] = []
    // The layout actually on screen. nil until first appearance, when it
    // follows `wantsSplit`; after that it only changes through onChange, so a
    // size-class change can't swap the tree before we've checked for a sheet.
    @State private var split: Bool?
    // A swap that is waiting for a sheet to close.
    @State private var pendingSplit: Bool?

    private var wantsSplit: Bool {
        let idiom = UIDevice.current.userInterfaceIdiom
        if idiom == .pad || idiom == .mac { return true }
        return horizontalSizeClass == .regular && verticalSizeClass == .regular
    }

    var body: some View {
        Group {
            if split ?? wantsSplit {
                IPadHomeView(position: $path, mySlug: auth.memberSlug)
            } else {
                HomeView(path: $path)
            }
        }
        // One toast surface for every failed mutation anywhere in the app.
        .errorToasts()
        .onAppear { if split == nil { split = wantsSplit } }
        .onChange(of: wantsSplit) { _, wanted in
            if wanted == split {
                pendingSplit = nil      // folded and unfolded again under a sheet
            } else if Self.isPresentingSheet {
                pendingSplit = wanted
            } else {
                split = wanted
            }
        }
        // There's no SwiftUI signal for "every sheet in the app has closed", so
        // a waiting swap checks twice a second. It only runs while a swap is
        // pending, and restarts (via the id) if the wanted layout flips again.
        .task(id: pendingSplit) {
            guard let target = pendingSplit else { return }
            while Self.isPresentingSheet {
                do { try await Task.sleep(for: .milliseconds(500)) } catch { return }
            }
            split = target
            pendingSplit = nil
        }
    }

    // Whether anything — sheet, full-screen cover, alert, share sheet — is
    // presented over the window. UIKit is the only place that knows about
    // presentations made deep inside the view tree (an edit sheet opened from
    // a show card), which is exactly the case that matters here.
    @MainActor private static var isPresentingSheet: Bool {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .contains { $0.isKeyWindow && $0.rootViewController?.presentedViewController != nil }
    }
}
