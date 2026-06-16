import SwiftUI

// Operator-only hub. Reached from HomeView only when auth.isAdmin (the
// /auth/check is_admin flag). Each tool calls an existing admin endpoint with
// the session cookie. More tools are added here as they ship.
struct AdminView: View {
    @EnvironmentObject private var auth: AuthStore

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
                    SignupRequestsView()
                } label: {
                    Label("Signup requests", systemImage: "tray.and.arrow.down")
                }
            }
            Section("Content") {
                NavigationLink {
                    UrlCleanupView()
                } label: {
                    Label("URL cleanup & titles", systemImage: "link.badge.plus")
                }
            }
        }
        .navigationTitle("Admin")
        .navigationBarTitleDisplayMode(.inline)
    }
}
