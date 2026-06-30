import SwiftUI

@main
struct ShowPickerTVApp: App {
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            RootTabView()
                .environmentObject(auth)
        }
    }
}
