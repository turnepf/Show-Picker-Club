import SwiftUI
import UniformTypeIdentifiers

// "Export My Lists" — fetches the plain-text export of the signed-in member's
// own lists from /api/export and hands it to the standard share sheet (Notes,
// Messages, Mail, Save to Files, …). Presented as a sheet from the account
// menu on Home.
//
// Sharing a file URL made every destination treat the export as an
// attachment: Notes stuck a .txt in the note instead of writing the lists
// into it, and Messages sent a document. Offering BOTH representations lets
// each destination take the one it wants — text where text belongs, a real
// .txt when saving to Files.
struct ExportedLists: Transferable {
    let text: String
    let filename: String

    static var transferRepresentation: some TransferRepresentation {
        // Order matters: the first representation a destination can accept is
        // the one it takes, and the text-shaped destinations are the ones the
        // file was wrong for.
        DataRepresentation(exportedContentType: .utf8PlainText) { export in
            Data(export.text.utf8)
        }
        .suggestedFileName { $0.filename }

        ProxyRepresentation(exporting: \.text)
    }
}
struct ExportListsView: View {
    @EnvironmentObject var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var export: ExportedLists?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                if let export {
                    Image(systemName: "square.and.arrow.up")
                        .font(.system(size: 44))
                        .foregroundStyle(.tint)
                    Text("Your lists are ready.")
                        .font(.headline)
                    Text("Share them to Notes, Messages, Files, or anywhere else.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    ShareLink(item: export, preview: SharePreview(export.filename)) {
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
        export = nil
        do {
            let text = try await API.exportText()
            let slug = auth.memberSlug ?? "lists"
            export = ExportedLists(text: text, filename: "showpicker-\(slug).txt")
        } catch {
            failed = true
        }
    }
}
