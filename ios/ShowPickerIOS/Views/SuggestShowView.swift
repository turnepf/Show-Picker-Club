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
    // Type-ahead: matching TMDB titles for what's typed, and the member's
    // exact pick (pinned through send so enrichment can't mismatch).
    @State private var titleHits: [TitleHit] = []
    @State private var picked: TitleHit?

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
                        .task(id: title) { await searchTitles() }
                    ForEach(titleHits) { hit in
                        Button { pick(hit) } label: { TitleHitRow(hit: hit) }
                            .buttonStyle(.plain)
                    }
                    Picker("Network", selection: $network) {
                        Text("None").tag("")
                        ForEach(CANONICAL_NETWORKS, id: \.self) { n in
                            Text(n).tag(n)
                        }
                    }
                } footer: {
                    if !titleHits.isEmpty {
                        Text("Tap the show you mean — poster, rating, and cast come with it.")
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

    // Debounced TMDB lookup for the typed title. .task(id: title) cancels the
    // in-flight search on every keystroke, so only the pause-after-typing one
    // actually hits the network.
    private func searchTitles() async {
        let q = title.trimmingCharacters(in: .whitespaces)
        if let p = picked, p.title == q { titleHits = []; return }
        picked = nil
        guard q.count >= 2 else { titleHits = []; return }
        try? await Task.sleep(nanoseconds: 300_000_000)
        if Task.isCancelled { return }
        let hits = (try? await API.titleSearch(q)) ?? []
        if !Task.isCancelled { titleHits = hits }
    }

    private func pick(_ hit: TitleHit) {
        picked = hit
        title = hit.title
        movie = hit.isMovie
        titleHits = []
    }

    private func send() async {
        sending = true
        defer { sending = false }
        let t = title.trimmingCharacters(in: .whitespaces)
        // Only send the pick while the field still holds the picked title —
        // hand-edits after picking fall back to title-search enrichment.
        let pin = (picked?.title == t) ? picked : nil
        do {
            try await API.suggest(to: targetSlug, title: t,
                                  network: network.isEmpty ? nil : network,
                                  notes: notes.isEmpty ? nil : notes,
                                  recommendedBy: recommendedBy.isEmpty ? nil : recommendedBy,
                                  movie: movie, fullSeries: fullSeries,
                                  tmdbId: pin?.tmdbId, tmdbType: pin?.mediaType)
            done = true
            try? await Task.sleep(nanoseconds: 800_000_000)
            dismiss()
        } catch {
            errorText = "Couldn't send. Are you logged in?"
        }
    }
}
