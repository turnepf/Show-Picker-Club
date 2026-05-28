import SwiftUI

@main
struct ShowPickerIOSApp: App {
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environmentObject(auth)
                .task { await auth.refresh() }
        }
    }
}
