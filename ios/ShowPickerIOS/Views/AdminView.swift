import SwiftUI

// Operator-only hub. Reached from HomeView only when auth.isAdmin (the
// /auth/check is_admin flag). Each tool calls an existing admin endpoint with
// the session cookie. More tools are added here as they ship.
struct AdminView: View {
    @EnvironmentObject private var auth: AuthStore

    // Public sign-up form. Submissions land in the Signup requests queue.
    private let joinURL = URL(string: "https://showpicker.club/join")!

    var body: some View {
        List {
            Section("Insights") {
                NavigationLink {
                    ReportingView()
                } label: {
                    Label("Reporting", systemImage: "chart.bar.xaxis")
                }
            }
            Section("Members") {
                NavigationLink {
                    CreateMemberView()
                } label: {
                    Label("Create member", systemImage: "person.badge.plus")
                }
                NavigationLink {
                    ManageMembersView()
                } label: {
                    Label("Manage members", systemImage: "person.2.badge.gearshape")
                }
                NavigationLink {
                    SignupRequestsView()
                } label: {
                    Label("Signup requests", systemImage: "tray.and.arrow.down")
                }
            }
            Section {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sign-up link")
                        Link("showpicker.club/join", destination: joinURL)
                            .font(.caption)
                    }
                    Spacer()
                    ShareLink(item: joinURL,
                              subject: Text("Show Picker Club"),
                              message: Text("Join Show Picker Club")) {
                        Image(systemName: "square.and.arrow.up").font(.title3)
                    }
                    .buttonStyle(.borderless)
                }
            } header: {
                Text("Invite")
            } footer: {
                Text("Send this to someone you want in the club — they fill out the form and land in Signup requests.")
            }
            Section("Content") {
                NavigationLink {
                    UrlCleanupView()
                } label: {
                    Label("URL cleanup & titles", systemImage: "link.badge.plus")
                }
                NavigationLink {
                    VibeAdminView()
                } label: {
                    Label("Vibe trait scoring", systemImage: "sparkles")
                }
            }
        }
        .navigationTitle("Admin")
        .navigationBarTitleDisplayMode(.inline)
    }
}
