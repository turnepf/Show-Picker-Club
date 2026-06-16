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
        }
        .navigationTitle("Admin")
        .navigationBarTitleDisplayMode(.inline)
    }
}
