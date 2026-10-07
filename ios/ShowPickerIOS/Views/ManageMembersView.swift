import SwiftUI

// Operator tool: the single member-administration hub, mirroring the web
// /members page capability-for-capability. The full roster — rename, edit
// login emails/phones, disable/enable, and hand off the admin role
// (GET/POST /api/admin-member-emails, /api/admin-member-disable,
// /api/admin-member-role). Reached from AdminView → Manage members.
// Everyone self-enrolls (migration 058), so there is no approval queue.
//
// The "Possible duplicates" panel (heuristic detection + merge/ignore UI)
// was removed here and on the web — Patrick decided not to keep worrying
// about it. A monthly GitHub Action now emails him if it finds anything;
// the merge and ignore endpoints (/api/admin-member-merge,
// /api/admin-dupe-ignores) still exist server-side for manual use if a
// real duplicate turns up, just with no UI trigger anywhere.
struct ManageMembersView: View {
    @State private var members: [AdminMember] = []
    @State private var loading = true

    // Tap a platform badge above the roster to show only members who've
    // ever used it; tap the active one again to clear. nil = no filter.
    @State private var platformFilter: String?

    var body: some View {
        List {
            Section {
                platformFilterRow
            } header: {
                Text("Filter by platform")
            } footer: {
                if let key = platformFilter, let label = Self.platformBadgeOrder.first(where: { $0.0 == key })?.1 {
                    Text("Showing members who've used \(label). Tap it again to clear.")
                }
            }
            Section("Members (\(sortedMembers.count))") {
                ForEach(sortedMembers) { m in
                    NavigationLink {
                        MemberDetailAdminView(member: m) { await load() }
                    } label: {
                        memberRow(m)
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

    // ---- Roster ----

    @ViewBuilder private func memberRow(_ m: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(m.personName).font(.body)
                if m.isAdmin == true { statusTag("ADMIN", .blue) }
                if m.disabled == true { statusTag("DISABLED", .red) }
            }
            Text(contactSummary(m)).font(.caption).foregroundStyle(.secondary)
            Text(lastActivityText(m.lastActivityAt)).font(.caption).foregroundStyle(.secondary)
            activityPills(m)
            platformBadges(m)
        }
        .opacity(m.disabled == true ? 0.6 : 1)
    }

    // The badge order, the badges themselves and the activity pills live in
    // MemberAdminDetail.swift — the roster rows and the member's own admin
    // screen draw the same three things, and two copies would drift the first
    // time a platform is added.
    private static let platformBadgeOrder = adminPlatformBadgeOrder

    // Same badges, same layout, but tappable: picks which platform
    // `sortedMembers` filters the roster down to.
    @ViewBuilder private var platformFilterRow: some View {
        FlowLayout(spacing: 4) {
            ForEach(Self.platformBadgeOrder, id: \.0) { key, label in
                let selected = platformFilter == key
                Button {
                    platformFilter = selected ? nil : key
                } label: {
                    Text(label)
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(
                            selected ? Color.accentColor.opacity(0.15) : Color.clear,
                            in: Capsule())
                        .overlay(Capsule().stroke(Color.secondary.opacity(0.25), lineWidth: selected ? 0 : 1))
                        .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func platformBadges(_ m: AdminMember) -> some View {
        AdminPlatformBadges(platforms: m.platforms ?? [])
    }

    private func activityPills(_ m: AdminMember) -> some View {
        AdminActivityPills(activity: m.activity30d)
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

    // Always most-recent-activity first (last_activity_at, the member's
    // latest library touch); members with no recorded activity sink to the
    // bottom, alphabetically. The server normalises the timestamp format,
    // so plain string comparison orders correctly.
    private var sortedMembers: [AdminMember] {
        let filtered = platformFilter.map { key in
            members.filter { ($0.platforms ?? []).contains(key) }
        } ?? members
        let byName: (AdminMember, AdminMember) -> Bool = {
            $0.personName.localizedCaseInsensitiveCompare($1.personName) == .orderedAscending
        }
        return filtered.sorted {
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
    case "same_member": return "Pick two different accounts."
    case "unknown_member": return "One of those accounts no longer exists — pull to refresh."
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

private func parseServerDate(_ iso: String) -> Date? {
    ISO8601DateFormatter().date(from: iso)
        ?? isoFractionalFormatter.date(from: iso)
        ?? sqliteDateFormatter.date(from: iso)
}

private func relTime(_ d: Date) -> String {
    let days = Int(Date().timeIntervalSince(d) / 86_400)
    switch days {
    case ..<1: return "today"
    case 1: return "yesterday"
    case ..<30: return "\(days)d ago"
    case ..<365: return "\(days / 30)mo ago"
    default: return "\(days / 365)y ago"
    }
}

func lastActivityText(_ iso: String?) -> String {
    guard let iso, let d = parseServerDate(iso) else { return "no activity yet" }
    return "last activity \(relTime(d))"
}

// The bare relative stamp ("today", "3d ago") for callers that bring their own
// wording — the member page's recent-adds rows, which put the time under the
// line rather than inside it. Nil for a missing or unparseable timestamp, so
// the caller can leave the row's second line off entirely.
func relativeServerTime(_ iso: String?) -> String? {
    guard let iso, let d = parseServerDate(iso) else { return nil }
    return relTime(d)
}

// "last login 3d ago via Apple" — the method is what says whether a login
// channel is still earning its keep, per member rather than in aggregate.
func lastLoginText(_ iso: String?, method: String? = nil) -> String {
    guard let iso, let d = parseServerDate(iso) else { return "never logged in" }
    var line = "last login \(relTime(d))"
    if let m = method, !m.isEmpty { line += " via \(loginMethodLabel(m))" }
    return line
}

func loginMethodLabel(_ key: String) -> String {
    switch key {
    case "apple": return "Apple"
    case "google": return "Google"
    case "email": return "email code"
    case "sms": return "text code"
    case "demo": return "demo login"
    default: return key
    }
}

// Internal so the member page's admin strip can push the same editor rather
// than growing a second one.
struct MemberDetailAdminView: View {
    let member: AdminMember
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var firstName: String
    @State private var lastName: String
    @State private var emails: String
    @State private var phones: String
    @State private var isDisabled: Bool
    @State private var isAdmin: Bool
    @State private var working = false
    @State private var banner: String?
    @State private var confirmDisable = false
    @State private var confirmAdmin = false

    init(member: AdminMember, onChange: @escaping () async -> Void) {
        self.member = member
        self.onChange = onChange
        _firstName = State(initialValue: member.firstName ?? "")
        _lastName = State(initialValue: member.lastName ?? "")
        _emails = State(initialValue: member.emails.joined(separator: ", "))
        _phones = State(initialValue: member.phones.joined(separator: ", "))
        _isDisabled = State(initialValue: member.disabled ?? false)
        _isAdmin = State(initialValue: member.isAdmin ?? false)
    }

    var body: some View {
        Form {
            // Who this is and whether they're using it, above the controls
            // that act on them. This is the operator's view of the member;
            // the link below is the member's own view of themselves.
            MemberAdminDetail(member: member)

            Section {
                NavigationLink {
                    MemberView(member: member.asMember)
                } label: {
                    Label("Open member page", systemImage: "person.crop.rectangle.stack")
                }
            } footer: {
                Text("Their four lists, exactly as they see them.")
            }

            Section {
                TextField("Alice — or Paula & Brad for a shared list", text: $firstName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                TextField("Last name", text: $lastName)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
            } header: {
                Text("Name")
            } footer: {
                Text("First name(s) is what the club sees — a shared list can use \"Paula & Brad\". Renames keep the member's slug and URL (@\(member.slug)).")
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
        return bits.isEmpty ? "Active member." : bits.joined(separator: " ")
    }

    private func save() async {
        working = true
        defer { working = false }
        banner = nil
        do {
            let r = try await API.updateMemberContacts(
                slug: member.slug,
                firstName: firstName.trimmingCharacters(in: .whitespacesAndNewlines),
                lastName: lastName.trimmingCharacters(in: .whitespacesAndNewlines),
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

// Wraps subviews onto new rows instead of overflowing or scrolling —
// mirrors the web roster's `flex-wrap` platform badges on narrow widths.
// Internal rather than file-private because the member page's admin strip
// lays out the same platform badges.
struct FlowLayout: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0, x + size.width > maxWidth {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
        y += rowHeight
        return CGSize(width: maxWidth.isFinite ? maxWidth : x, height: y)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var rowHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
