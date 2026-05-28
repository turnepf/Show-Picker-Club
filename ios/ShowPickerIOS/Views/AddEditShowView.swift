import SwiftUI

// Sheet for adding a new show or editing an existing one. Standard Form
// layout with system controls — Section / TextField / Picker / Toggle.
struct AddEditShowView: View {
    let memberSlug: String
    let existing: Show?
    let onSave: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var network = ""
    @State private var list: ShowList = .watching
    @State private var notes = ""
    @State private var recommendedBy = ""
    @State private var watchingWith = ""
    @State private var movie = false
    @State private var fullSeries = false
    @State private var archived = false
    @State private var saving = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
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
                Section("List") {
                    Picker("List", selection: $list) {
                        ForEach(ShowList.allCases) { l in Text(l.title).tag(l) }
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    TextField("Recommended by", text: $recommendedBy)
                    TextField("Watching with", text: $watchingWith)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
                }
                Section {
                    Toggle("Movie", isOn: $movie)
                    Toggle("Series complete", isOn: $fullSeries)
                    if existing != nil {
                        Toggle("Archived", isOn: $archived)
                    }
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle(existing == nil ? "Add Show" : "Edit Show")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(existing == nil ? "Add" : "Save") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .interactiveDismissDisabled(saving)
            .onAppear(perform: prefill)
            .overlay { if saving { ProgressView().controlSize(.large) } }
        }
    }

    private func prefill() {
        guard let s = existing else { return }
        title = s.title
        network = s.network ?? ""
        list = ShowList(rawValue: s.list) ?? .watching
        notes = s.notes ?? ""
        recommendedBy = s.recommendedBy ?? ""
        watchingWith = s.watchingWith ?? ""
        movie = s.isMovie
        fullSeries = s.isFullSeries
        archived = s.isArchived
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let t = title.trimmingCharacters(in: .whitespaces)
        let net = network.isEmpty ? nil : network
        let n = notes.trimmingCharacters(in: .whitespaces).isEmpty ? nil : notes
        let rec = recommendedBy.trimmingCharacters(in: .whitespaces).isEmpty ? nil : recommendedBy
        let ww = watchingWith.trimmingCharacters(in: .whitespaces).isEmpty ? nil : watchingWith
        do {
            if let s = existing {
                _ = try await API.updateShow(id: s.id, title: t, network: net, list: list.rawValue,
                                             notes: n, recommendedBy: rec, movie: movie,
                                             fullSeries: fullSeries, watchingWith: ww, archived: archived)
            } else {
                _ = try await API.addShow(memberSlug: memberSlug, title: t, network: net, list: list.rawValue,
                                          notes: n, recommendedBy: rec, movie: movie,
                                          fullSeries: fullSeries, watchingWith: ww)
            }
            await onSave()
            dismiss()
        } catch {
            errorText = "Couldn't save. Are you logged in?"
        }
    }
}
