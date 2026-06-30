import SwiftUI

// The account tab: the sign-in form when logged out, identity + log out when
// signed in. Signing in flips RootTabView over to the My Shows tab.
struct AccountView: View {
    @EnvironmentObject private var auth: AuthStore

    var body: some View {
        if auth.isLoggedIn {
            ZStack {
                Theme.background.ignoresSafeArea()
                VStack(spacing: 30) {
                    Image(systemName: "person.crop.circle.fill")
                        .font(.system(size: 96))
                        .foregroundColor(Theme.text)
                    Text(auth.email ?? "Signed in")
                        .font(.system(size: 40, weight: .bold))
                        .foregroundColor(Theme.text)
                    if auth.isAdmin {
                        Text("Operator")
                            .font(.system(size: 22))
                            .foregroundColor(Theme.muted)
                    }
                    Button("Log out") { Task { await auth.logout() } }
                        .font(.system(size: 26, weight: .semibold))
                        .padding(.top, 12)
                }
            }
        } else {
            LoginView()
        }
    }
}
