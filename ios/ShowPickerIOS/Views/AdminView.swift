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
                    ManageMembersView()
                } label: {
                    Label("Manage members", systemImage: "person.2.badge.gearshape")
                }
            }
            Section("Content") {
                NavigationLink {
                    UrlCleanupView()
                } label: {
                    Label("Show Cleanup", systemImage: "link.badge.plus")
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
