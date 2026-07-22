import SwiftUI

// Operator-only hub. Reached from HomeView only when auth.isAdmin (the
// /auth/check is_admin flag). Each tool calls an existing admin endpoint with
// the session cookie. More tools are added here as they ship.
struct AdminView: View {
    @EnvironmentObject private var auth: AuthStore

    // Everyone waiting to get in: pending /join requests + held self-enrolled
    // members. Shown as a badge on the Manage members row — the queue lives
    // at the top of that screen, matching the web /members page.
    @State private var waitingCount = 0

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
                .badge(waitingCount)
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
        .task { await loadWaitingCount() }
    }

    private func loadWaitingCount() async {
        let pending = ((try? await API.signupRequests()) ?? []).filter { $0.status == "pending" }.count
        let held = ((try? await API.adminMembers()) ?? []).filter { $0.approved == false }.count
        waitingCount = pending + held
    }
}
