import SwiftUI

@main
struct ShowPickerTVApp: App {
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            // Browsing is open, like iOS — the home screen shows members and
            // shows whether or not you're signed in. Refreshing the session in
            // the background lets HomeView jump a logged-in member to their own
            // list once auth resolves.
            HomeView()
                .environmentObject(auth)
                .task { await auth.refresh() }
        }
    }
}
