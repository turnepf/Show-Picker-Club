import SwiftUI

struct SuggestShowView: View {
    let targetSlug: String
    let targetName: String

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var network = ""
    @State private var notes = ""
    @State private var recommendedBy = ""
    @State private var movie = false
    @State private var fullSeries = false
    @State private var sending = false
    @State private var errorText: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Suggest a show for \(targetName)'s Up Next list.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section {
                    TextField("Title", text: $title)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)
                    Picker("Network", selection: $network) {
                        Text("None").tag("")
                        ForEach(CANONICAL_NETWORKS, id: \.self) { n in
                            Text(n).tag(n)
                        }
                    }
                }
                Section {
                    TextField("Your name (so they know who suggested it)", text: $recommendedBy)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    Toggle("Movie", isOn: $movie)
                    Toggle("Series complete", isOn: $fullSeries)
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }
                if done {
                    Section { Text("Sent! It'll appear in \(targetName)'s Up Next list.").foregroundStyle(.green) }
                }
            }
            .navigationTitle("Suggest")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await send() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || sending)
                }
            }
            .overlay { if sending { ProgressView().controlSize(.large) } }
        }
    }

    private func send() async {
        sending = true
        defer { sending = false }
        let t = title.trimmingCharacters(in: .whitespaces)
        do {
            try await API.suggest(to: targetSlug, title: t,
                                  network: network.isEmpty ? nil : network,
                                  notes: notes.isEmpty ? nil : notes,
                                  recommendedBy: recommendedBy.isEmpty ? nil : recommendedBy,
                                  movie: movie, fullSeries: fullSeries)
            done = true
            try? await Task.sleep(nanoseconds: 800_000_000)
            dismiss()
        } catch {
            errorText = "Couldn't send. Are you logged in?"
        }
    }
}
