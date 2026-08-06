import SwiftUI

// The account tab: the sign-in form when logged out, identity + log out when
// signed in. Signing in flips RootTabView over to the My Shows tab.
struct AccountView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var showingDelete = false

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
                    Button("Log Out") { Task { await auth.logout() } }
                        .font(.system(size: 26, weight: .semibold))
                        .padding(.top, 12)
                    // Not `role: .destructive`: tvOS fills the capsule red and
                    // tints the label the same red, so the button reads as a
                    // blank red pill. Red text on the standard capsule says
                    // "destructive" just as clearly, and can be read.
                    Button {
                        showingDelete = true
                    } label: {
                        Text("Delete Account…")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundColor(.red)
                    }
                }
            }
            .fullScreenCover(isPresented: $showingDelete) {
                DeleteAccountView()
            }
        } else {
            LoginView()
        }
    }
}
