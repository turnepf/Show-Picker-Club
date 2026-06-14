import SwiftUI

// Mirrors ShowList from the main app's Models.swift.
private enum ShareList: String, CaseIterable, Identifiable {
    case watching, waiting, recommending, next
    var id: String { rawValue }
    var label: String {
        switch self {
        case .watching:     return "Watching"
        case .waiting:      return "Waiting"
        case .recommending: return "Recommending"
        case .next:         return "Up Next"
        }
    }
}

struct ShareComposeView: View {
    let onComplete: () -> Void
    let onCancel:   () -> Void

    @State private var title:   String
    @State private var network: String
    @State private var list:    ShareList = .next
    @State private var notes  = ""
    @State private var movie  = false
    @State private var saving = false
    @State private var errorText: String?

    init(suggestedTitle: String, suggestedNetwork: String?,
         onComplete: @escaping () -> Void, onCancel: @escaping () -> Void) {
        self.onComplete = onComplete
        self.onCancel   = onCancel
        _title   = State(initialValue: suggestedTitle)
        _network = State(initialValue: suggestedNetwork ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Title", text: $title)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.words)
                }
                Section {
                    TextField("Network", text: $network)
                        .autocorrectionDisabled()
                }
                Section("List") {
                    Picker("List", selection: $list) {
                        ForEach(ShareList.allCases) { l in Text(l.label).tag(l) }
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    Toggle("Movie", isOn: $movie)
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(2...5)
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Add to Show Picker")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { onCancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Add") { Task { await save() } }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || saving)
                }
            }
            .overlay { if saving { ProgressView().controlSize(.large) } }
        }
    }

    private func save() async {
        guard let slug = SharedSession.memberSlug else {
            errorText = "Not logged in — open Show Picker first."
            return
        }
        saving = true
        defer { saving = false }
        let t   = title.trimmingCharacters(in: .whitespaces)
        let net = network.trimmingCharacters(in: .whitespaces).nilIfEmpty
        let n   = notes.trimmingCharacters(in: .whitespaces).nilIfEmpty
        do {
            try await ShareAPI.addShow(memberSlug: slug, title: t, network: net,
                                       list: list.rawValue, notes: n, movie: movie)
            onComplete()
        } catch ShareAPI.APIError.notLoggedIn {
            errorText = "Not logged in — open Show Picker first."
        } catch {
            errorText = "Couldn't save — check your connection."
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
