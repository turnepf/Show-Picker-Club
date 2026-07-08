import SwiftUI

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
                }
                .onChange(of: scenePhase) { _, phase in
                    // Returning to the foreground is a good moment to retry.
                    if phase == .active { Task { await OfflineQueue.shared.flush() } }
                }
        }
    }
}
