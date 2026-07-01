import SwiftUI

@main
struct ShowPickerWatchApp: App {
    @StateObject private var auth = WatchAuth()

    var body: some Scene {
        WindowGroup {
            ListsView()
                .environmentObject(auth)
        }
    }
}
