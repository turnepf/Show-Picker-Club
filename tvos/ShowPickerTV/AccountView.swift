import SwiftUI

// The account tab: the sign-in form when logged out, identity + log out when
// signed in. Signing in flips RootTabView over to the My Shows tab.
struct AccountView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var showingDelete = false
    @State private var showingLinkCheck = false

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
                        // Operator-only: which streaming apps this particular
                        // Apple TV will actually open. Services retire their
                        // URL schemes without notice, and a real device is the
                        // only place to find out.
                        Button("Streaming Link Check…") { showingLinkCheck = true }
                            .font(.system(size: 22, weight: .semibold))
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
                // Dark plate + light text unfocused, white plate focused. The
                // system style takes its unfocused plate from the box's
                // appearance, which on our always-dark canvas can come out
                // black-on-dark. The Delete label keeps its own red — the
                // label's foreground wins over the style's.
                .buttonStyle(ActionButtonStyle())
            }
            .fullScreenCover(isPresented: $showingDelete) {
                DeleteAccountView()
            }
            .fullScreenCover(isPresented: $showingLinkCheck) {
                StreamingLinkCheckView()
            }
        } else {
            LoginView()
        }
    }
}
