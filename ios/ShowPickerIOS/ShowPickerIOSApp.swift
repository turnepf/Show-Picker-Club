import SwiftUI
import WidgetKit

@main
struct ShowPickerIOSApp: App {
    @StateObject private var auth = AuthStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
                .task {
                    Connectivity.shared.start()
                    // Activate WatchConnectivity early so the phone is ready to
                    // push the session and answer the watch's live request.
                    WatchBridge.shared.start()
                    await auth.refresh()
                    // Drain anything queued while the app was closed/offline.
                    await OfflineQueue.shared.flush()
                    // Warm the network picker from the server so the first Add
                    // Show of the session already has any newly added service.
                    // Needs no session, and a failure leaves the cached list.
                    await NetworkCatalogStore.shared.refresh()
                }
                .onChange(of: scenePhase) { _, phase in
                    // Returning to the foreground is a good moment to retry.
                    if phase == .active {
                        Task { await OfflineQueue.shared.flush() }
                        // And a good moment to re-pull the network list: an app
                        // can stay resident for days, so a launch-only refresh
                        // would leave this phone on a stale list all week.
                        Task { await NetworkCatalogStore.shared.refresh() }
                    }
                    // Leaving is when list edits made this session should reach
                    // the home-screen widgets (Upcoming reads the member's lists).
                    if phase == .background { WidgetCenter.shared.reloadAllTimelines() }
                }
        }
        .commands { AppCommands() }
    }
}
