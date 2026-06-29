import SwiftUI

// Operator tool: edit members' login emails and phone numbers.
// GET/POST /api/admin-member-emails. Reached from AdminView → Members.
struct ManageMembersView: View {
    @State private var members: [AdminMember] = []
    @State private var loading = true

    var body: some View {
        List {
            ForEach(members) { m in
                NavigationLink {
                    MemberContactEditView(member: m) { await load() }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(displayName(m)).font(.body)
                        Text(contactSummary(m)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Members")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && members.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    private func displayName(_ m: AdminMember) -> String {
        m.name ?? [m.firstName, m.lastName].compactMap { $0 }.joined(separator: " ")
            .ifEmpty(m.slug)
    }

    private func contactSummary(_ m: AdminMember) -> String {
        let e = m.emails.count
        let p = m.phones.count
        return "\(e) email\(e == 1 ? "" : "s") · \(p) phone\(p == 1 ? "" : "s")"
    }

    private func load() async {
        loading = true
        defer { loading = false }
        members = (try? await API.adminMembers()) ?? []
    }
}

private struct MemberContactEditView: View {
    let member: AdminMember
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var emails: String
    @State private var phones: String
    @State private var working = false
    @State private var banner: String?

    init(member: AdminMember, onChange: @escaping () async -> Void) {
        self.member = member
        self.onChange = onChange
        _emails = State(initialValue: member.emails.joined(separator: ", "))
        _phones = State(initialValue: member.phones.joined(separator: ", "))
    }

    var body: some View {
        Form {
            Section {
                TextField("name@example.com, …", text: $emails, axis: .vertical)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            } header: {
                Text("Emails")
            } footer: {
                Text("Comma- or space-separated. Leave empty to clear.")
            }

            Section {
                TextField("+1 555 123 4567, …", text: $phones, axis: .vertical)
                    .keyboardType(.phonePad)
            } header: {
                Text("Phones")
            } footer: {
                Text("Comma-separated. Editing phones re-syncs login codes.")
            }

            Section {
                Button("Save") { Task { await save() } }.disabled(working)
            }

            if let b = banner {
                Section { Text(b).foregroundStyle(b.hasPrefix("✓") ? .green : .red) }
            }
        }
        .navigationTitle(member.name ?? member.slug)
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if working { ProgressView().controlSize(.large) } }
    }

    private func save() async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await API.updateMemberContacts(
                slug: member.slug,
                emails: emails.trimmingCharacters(in: .whitespacesAndNewlines),
                phones: phones.trimmingCharacters(in: .whitespacesAndNewlines))
            if let e = r.error { banner = e }
            else {
                banner = "✓ Saved"
                await onChange()
                try? await Task.sleep(nanoseconds: 600_000_000)
                dismiss()
            }
        } catch { banner = "Network error. Try again." }
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String {
        trimmingCharacters(in: .whitespaces).isEmpty ? fallback : self
    }
}
