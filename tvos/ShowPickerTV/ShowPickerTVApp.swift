import SwiftUI

@main
struct ShowPickerTVApp: App {
    @StateObject private var auth = AuthStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
        }
    }
}

// Gate the member lists behind login. Until the first auth check returns we
// show a splash so the login screen doesn't flash for already-signed-in TVs;
// after that it's the lists (logged in) or the login screen.
struct RootView: View {
    @EnvironmentObject private var auth: AuthStore

    var body: some View {
        Group {
            if !auth.checked {
                ZStack {
                    Theme.cream.ignoresSafeArea()
                    ProgressView()
                }
            } else if auth.isLoggedIn {
                HomeView()
            } else {
                LoginView()
            }
        }
        .task { await auth.refresh() }
    }
}
