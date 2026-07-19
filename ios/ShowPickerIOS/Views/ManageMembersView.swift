import SwiftUI

// Operator tool: the full member roster — rename, edit login emails/phones,
// disable/enable, approve held members, and hand off the admin role. Mirrors
// the web /members page capability-for-capability (GET/POST
// /api/admin-member-emails, /api/admin-member-disable,
// /api/admin-member-approve, /api/admin-member-role). Reached from
// AdminView → Manage members.
struct ManageMembersView: View {
    @State private var members: [AdminMember] = []
    @State private var loading = true

    var body: some View {
        List {
            ForEach(sortedMembers) { m in
                NavigationLink {
                    MemberDetailAdminView(member: m) { await load() }
                } label: {
                    memberRow(m)
                }
            }
        }
        .navigationTitle("Members")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && members.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private func memberRow(_ m: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(m.personName).font(.body)
                if m.isAdmin == true { statusTag("ADMIN", .blue) }
                if m.disabled == true { statusTag("DISABLED", .red) }
                if m.approved == false { statusTag("PENDING", .orange) }
            }
            Text(contactSummary(m)).font(.caption).foregroundStyle(.secondary)
            Text(contextLine(m)).font(.caption).foregroundStyle(.secondary)
        }
        .opacity(m.disabled == true ? 0.6 : 1)
    }

    private func statusTag(_ text: String, _ color: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(color)
    }

    private func contactSummary(_ m: AdminMember) -> String {
        let e = m.emails.count
        let p = m.phones.count
        var parts = ["\(e) email\(e == 1 ? "" : "s") · \(p) phone\(p == 1 ? "" : "s")"]
        if let via = m.enrolledVia, !via.isEmpty { parts.append("via \(via)") }
        return parts.joined(separator: " · ")
    }

    // Last activity + 30-day list activity, matching the web roster's context
    // row. Last activity (the member's latest library touch) reads better for
    // engagement than last login, and it matches the list's fixed sort order.
    private func contextLine(_ m: AdminMember) -> String {
        var parts = [lastActivityText(m.lastActivityAt)]
        if let a = m.activity30d {
            let total = a.watching + a.waiting + a.recommending + a.next
            parts.append(total == 0 ? "no list activity in 30 days" : "\(total) list adds in 30 days")
        }
        return parts.joined(separator: " · ")
    }

    // Always most-recent-activity first (last_activity_at, the member's
    // latest library touch); members with no recorded activity sink to the
    // bottom, alphabetically. The server normalises the timestamp format,
    // so plain string comparison orders correctly.
    private var sortedMembers: [AdminMember] {
        let byName: (AdminMember, AdminMember) -> Bool = {
            $0.personName.localizedCaseInsensitiveCompare($1.personName) == .orderedAscending
        }
        return members.sorted {
            switch ($0.lastActivityAt, $1.lastActivityAt) {
            case (nil, nil): return byName($0, $1)
            case (nil, _): return false
            case (_, nil): return true
            case let (a?, b?): return a == b ? byName($0, $1) : a > b
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        members = (try? await API.adminMembers()) ?? []
    }
}

// Server error codes → operator-readable explanations, matching the web page.
// Unknown codes fall through raw so new errors aren't hidden.
func friendlyAdminError(_ code: String) -> String {
    switch code {
    case "cannot_disable_self": return "You can't disable yourself."
    case "cannot_disable_admin": return "Remove their admin role first, then disable."
    case "cannot_promote_disabled": return "Enable the member before making them an admin."
    case "last_admin": return "They're the only admin — make someone else an admin first."
    default: return code
    }
}

// Server timestamps have arrived in three shapes over time: SQLite
// "yyyy-MM-dd HH:mm:ss" (UTC), ISO 8601 with milliseconds (JS
// toISOString — a bare ISO8601DateFormatter rejects fractional seconds,
// which once made every member read "never logged in"), and the current
// fraction-less ISO. Accept all three.
private let sqliteDateFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    f.timeZone = TimeZone(identifier: "UTC")
    f.locale = Locale(identifier: "en_US_POSIX")
    return f
}()

private let isoFractionalFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func lastActivityText(_ iso: String?) -> String {
    guard let iso,
          let d = ISO8601DateFormatter().date(from: iso)
              ?? isoFractionalFormatter.date(from: iso)
              ?? sqliteDateFormatter.date(from: iso)
    else { return "no activity yet" }
    let days = Int(Date().timeIntervalSince(d) / 86_400)
    let when: String
    switch days {
    case ..<1: when = "today"
    case 1: when = "yesterday"
    case ..<30: when = "\(days)d ago"
    case ..<365: when = "\(days / 30)mo ago"
    default: when = "\(days / 365)y ago"
    }
    return "last activity \(when)"
}

private struct MemberDetailAdminView: View {
    let member: AdminMember
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var emails: String
    @State private var phones: String
    @State private var isDisabled: Bool
    @State private var isApproved: Bool
    @State private var isAdmin: Bool
    @State private var working = false
    @State private var banner: String?
    @State private var confirmDisable = false
    @State private var confirmAdmin = false

    init(member: AdminMember, onChange: @escaping () async -> Void) {
        self.member = member
        self.onChange = onChange
        _name = State(initialValue: [member.firstName, member.lastName].compactMap { $0 }.joined(separator: " "))
        _emails = State(initialValue: member.emails.joined(separator: ", "))
        _phones = State(initialValue: member.phones.joined(separator: ", "))
        _isDisabled = State(initialValue: member.disabled ?? false)
        _isApproved = State(initialValue: member.approved ?? true)
        _isAdmin = State(initialValue: member.isAdmin ?? false)
    }

    var body: some View {
        Form {
            Section {
                TextField("Alice Baker", text: $name)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
            } header: {
                Text("Name")
            } footer: {
                Text("Renames keep the member's slug and URL (@\(member.slug)).")
            }

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

            Section {
                if !isApproved {
                    Button {
                        Task { await approve() }
                    } label: {
                        Label("Approve member", systemImage: "checkmark.circle.fill")
                    }
                    .tint(.orange)
                }

                Button {
                    confirmAdmin = true
                } label: {
                    Label(isAdmin ? "Remove admin" : "Make admin",
                          systemImage: isAdmin ? "person.badge.minus" : "person.badge.shield.checkmark")
                }
                .tint(.blue)
                .confirmationDialog(
                    isAdmin ? "Remove admin from \(member.personName)?"
                            : "Make \(member.personName) an admin? They get member management and every admin tool.",
                    isPresented: $confirmAdmin, titleVisibility: .visible
                ) {
                    Button(isAdmin ? "Remove admin" : "Make admin") { Task { await toggleAdmin() } }
                }

                Button(role: isDisabled ? nil : ButtonRole.destructive) {
                    if isDisabled { Task { await toggleDisabled() } } else { confirmDisable = true }
                } label: {
                    Label(isDisabled ? "Enable member" : "Disable member",
                          systemImage: isDisabled ? "person.fill.checkmark" : "person.slash")
                }
                .confirmationDialog(
                    "Disable \(member.personName)? They'll be logged out everywhere and can't log back in until re-enabled.",
                    isPresented: $confirmDisable, titleVisibility: .visible
                ) {
                    Button("Disable", role: .destructive) { Task { await toggleDisabled() } }
                }
            } header: {
                Text("Status")
            } footer: {
                Text(statusFooter)
            }
            .disabled(working)

            if let b = banner {
                Section { Text(b).foregroundStyle(b.hasPrefix("✓") ? .green : .red) }
            }
        }
        .navigationTitle(member.personName)
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if working { ProgressView().controlSize(.large) } }
    }

    private var statusFooter: String {
        var bits: [String] = []
        if isAdmin { bits.append("Admin.") }
        if isDisabled { bits.append("Disabled — can't log in.") }
        if !isApproved { bits.append("Held — hidden from the roster until approved.") }
        return bits.isEmpty ? "Active member." : bits.joined(separator: " ")
    }

    private func save() async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await API.updateMemberContacts(
                slug: member.slug,
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                emails: emails.trimmingCharacters(in: .whitespacesAndNewlines),
                phones: phones.trimmingCharacters(in: .whitespacesAndNewlines))
            if let e = r.error { banner = friendlyAdminError(e) }
            else {
                banner = "✓ Saved"
                await onChange()
                try? await Task.sleep(nanoseconds: 600_000_000)
                dismiss()
            }
        } catch { banner = "Network error. Try again." }
    }

    private func approve() async {
        await run { try await API.approveMember(slug: member.slug) } onOK: { isApproved = true }
    }

    private func toggleAdmin() async {
        let target = !isAdmin
        await run { try await API.setMemberAdmin(slug: member.slug, admin: target) } onOK: { isAdmin = target }
    }

    private func toggleDisabled() async {
        let target = !isDisabled
        await run { try await API.setMemberDisabled(slug: member.slug, disabled: target) } onOK: { isDisabled = target }
    }

    private func run(_ call: () async throws -> AdminActionResult, onOK: () -> Void) async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await call()
            if let e = r.error { banner = friendlyAdminError(e) }
            else {
                onOK()
                banner = "✓ Done"
                await onChange()
            }
        } catch { banner = "Network error. Try again." }
    }
}
