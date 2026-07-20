import SwiftUI

// "Export My Lists" — fetches the plain-text export of the signed-in
// member's own lists from /api/export, writes it to a temp .txt file, and
// hands it to the standard iOS share sheet (Notes, Messages, Mail, Save to
// Files, …). Presented as a sheet from the account menu on Home.
struct ExportListsView: View {
    @EnvironmentObject var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var fileURL: URL?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let url = fileURL {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 44))
                        .foregroundStyle(.tint)
                    Text("Your lists are ready.")
                        .font(.headline)
                    Text("Share them to Notes, Messages, Files, or anywhere else.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    ShareLink(item: url) {
                        Label("Share…", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
                } else if failed {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 44))
                        .foregroundStyle(.secondary)
                    Text("Couldn't prepare your export.")
                        .font(.headline)
                    Text("Check your connection and try again.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button("Retry") { Task { await build() } }
                        .buttonStyle(.bordered)
                } else {
                    ProgressView("Preparing your lists…")
                }
            }
            .padding(24)
            .navigationTitle("Export My Lists")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await build() }
        }
    }

    @MainActor
    private func build() async {
        failed = false
        fileURL = nil
        do {
            let text = try await API.exportText()
            let slug = auth.memberSlug ?? "lists"
            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("showpicker-\(slug).txt")
            try text.data(using: .utf8)?.write(to: url, options: .atomic)
            fileURL = url
        } catch {
            failed = true
        }
    }
}
