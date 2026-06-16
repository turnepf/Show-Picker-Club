import SwiftUI

// Send an existing show to another member's Up Next, carrying over its
// enrichment. Mirrors the web "share" modal: pick a target member (everyone
// except the show's owner), add your name + an optional note, send.
struct ShareShowView: View {
    let showId: Int
    let showTitle: String
    let sourceMember: String

    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var members: [Member] = []
    @State private var target: String = ""
    @State private var recommendedBy = ""
    @State private var notes = ""
    @State private var sending = false
    @State private var errorText: String?
    @State private var resultText: String?

    // Everyone except the show's current owner is a valid recipient.
    private var recipients: [Member] {
        members.filter { $0.slug != sourceMember }
            .sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Send “\(showTitle)” to another member's Up Next list.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("To") {
                    if recipients.isEmpty {
                        Text("Loading members…").foregroundStyle(.secondary)
                    } else {
                        Picker("Member", selection: $target) {
                            ForEach(recipients) { m in Text("\(m.label)'s Shows").tag(m.slug) }
                        }
                    }
                }
                Section {
                    TextField("Your name (so they know who sent it)", text: $recommendedBy)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }
                if let r = resultText {
                    Section { Text(r).foregroundStyle(.green) }
                }
            }
            .navigationTitle("Send")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await send() } }
                        .disabled(target.isEmpty || sending)
                }
            }
            .overlay { if sending { ProgressView().controlSize(.large) } }
            .task { await loadMembers() }
        }
    }

    private func loadMembers() async {
        members = (try? await API.members()) ?? []
        if target.isEmpty { target = recipients.first?.slug ?? "" }
        // Default the recommender to the logged-in member's display name.
        if recommendedBy.isEmpty, let mine = auth.memberSlug,
           let me = members.first(where: { $0.slug == mine }) {
            recommendedBy = me.label
        }
    }

    private func send() async {
        guard !target.isEmpty else { return }
        sending = true
        defer { sending = false }
        errorText = nil
        let name = recommendedBy.trimmingCharacters(in: .whitespaces)
        let targetName = recipients.first(where: { $0.slug == target })?.label ?? "their"
        do {
            let outcome = try await API.shareShow(
                showId: showId,
                sourceMember: sourceMember,
                targetMember: target,
                recommendedBy: name.isEmpty ? "Anonymous" : name,
                notes: notes.trimmingCharacters(in: .whitespaces).isEmpty ? nil : notes
            )
            switch outcome {
            case .sent:
                resultText = "Sent to \(targetName)'s Up Next."
            case .duplicate(let list):
                let label = list.flatMap { ShowList(rawValue: $0)?.title } ?? "one of their lists"
                resultText = "They already have this on \(label)."
            case .duplicateArchived:
                resultText = "They had this one but archived it."
            }
            try? await Task.sleep(nanoseconds: 900_000_000)
            dismiss()
        } catch {
            errorText = "Couldn't send. Are you logged in?"
        }
    }
}
