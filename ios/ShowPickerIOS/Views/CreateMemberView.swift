import SwiftUI

// Operator tool: create a new member (POST /api/admin-create-member). Mirrors
// the web /setup flow — name plus a phone and/or emails; the server generates
// the slug and seeds 8 shows.
struct CreateMemberView: View {
    @State private var fullName = ""
    @State private var phone = ""
    @State private var emails = ""
    @State private var submitting = false
    @State private var errorText: String?
    @State private var result: CreateMemberResult?

    private var canSubmit: Bool {
        !fullName.trimmingCharacters(in: .whitespaces).isEmpty
            && (!phone.trimmingCharacters(in: .whitespaces).isEmpty
                || !emails.trimmingCharacters(in: .whitespaces).isEmpty)
            && !submitting
    }

    var body: some View {
        Form {
            Section {
                TextField("Full name", text: $fullName)
                    .textInputAutocapitalization(.words)
                TextField("Phone (optional)", text: $phone)
                    .keyboardType(.phonePad)
                TextField("Emails (comma-separated, optional)", text: $emails)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } footer: {
                Text(footerText)
            }

            Section {
                Button {
                    Task { await submit() }
                } label: {
                    HStack {
                        Text("Create member")
                        if submitting { Spacer(); ProgressView() }
                    }
                }
                .disabled(!canSubmit)
            }

            if let err = errorText {
                Section { Text(err).foregroundStyle(.red) }
            }

            if let r = result, r.error == nil {
                Section("Created") {
                    if let s = r.slug { labeled("Slug", "@\(s)") }
                    if let u = r.url { labeled("URL", u) }
                    if let seeded = r.seeded, !seeded.isEmpty {
                        DisclosureGroup("Seeded \(seeded.count) shows") {
                            ForEach(seeded, id: \.self) { Text($0).font(.callout) }
                        }
                    }
                    // Same welcome message the web /members page offers after
                    // a create — copy it or fire it straight off as a text.
                    if let s = r.slug {
                        WelcomeIntroPanel(
                            slug: s,
                            displayName: r.editorName ?? s,
                            phone: r.phone,
                            defaultOpen: true)
                    }
                }
            }
        }
        .navigationTitle("Create Member")
        .navigationBarTitleDisplayMode(.inline)
    }

    // Live preview of the slug/URL the server will mint (first name,
    // lowercased, alphanumerics only; a suffix is added on collision) —
    // mirrors the web form's preview line.
    private var footerText: String {
        let base = "Provide a phone, at least one email, or both — that's where login codes go."
        let first = fullName.trimmingCharacters(in: .whitespaces).split(separator: " ").first.map(String.init) ?? ""
        let slug = first.lowercased().filter { $0.isLetter || $0.isNumber }
        guard !slug.isEmpty else { return base }
        return "URL: showpicker.club/\(slug) (suffix added on collision) · Display: \(first)'s Shows\n\(base)"
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        HStack { Text(label); Spacer(); Text(value).foregroundStyle(.secondary).textSelection(.enabled) }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        errorText = nil
        result = nil
        do {
            let r = try await API.createMember(
                fullName: fullName.trimmingCharacters(in: .whitespaces),
                phone: phone.trimmingCharacters(in: .whitespaces),
                emails: emails.trimmingCharacters(in: .whitespaces)
            )
            if let e = r.error {
                errorText = e
            } else {
                result = r
                // Clear the form so it's ready for the next one.
                fullName = ""; phone = ""; emails = ""
            }
        } catch {
            errorText = "Couldn't reach the server. Try again."
        }
    }
}
