import SwiftUI

// Operator tool: the single member-administration hub, mirroring the web
// /members page capability-for-capability. The new-members queue (pending
// /join requests via /api/admin-signup-requests + held self-enrolled
// members via /api/admin-member-approve) sits at the top and disappears
// once everything is processed and hidden; then the Possible-duplicates
// panel (same heuristics as the web: private-relay-only accounts and shared
// first names; merge via /api/admin-member-merge, dismissals via
// /api/admin-dupe-ignores); below it, the full roster — rename, edit login
// emails/phones, disable/enable, approve held members, and hand off the
// admin role (GET/POST /api/admin-member-emails, /api/admin-member-disable,
// /api/admin-member-approve, /api/admin-member-role). Reached from
// AdminView → Manage members.
struct ManageMembersView: View {
    @State private var members: [AdminMember] = []
    @State private var requests: [SignupRequest] = []
    @State private var ignores: [DupeIgnore] = []
    @State private var loading = true
    @State private var working: Int?
    @State private var workingSlug: String?
    @State private var banner: String?

    // Duplicates panel state: which account each group keeps, the merge
    // target for lone hidden-email accounts, the manual-merge picks, and
    // the pending confirmation (merges and ignores both confirm first,
    // like the web).
    @State private var keepChoice: [String: String] = [:]
    @State private var loneTarget: [String: String] = [:]
    @State private var manualSource = ""
    @State private var manualTarget = ""
    @State private var mergePlan: MergePlan?
    @State private var ignorePlan: IgnorePlan?
    @State private var merging = false

    // Reject-with-note (the web's prompt() equivalent).
    @State private var rejectTarget: SignupRequest?
    @State private var rejectNote = ""

    private var held: [AdminMember] { members.filter { $0.approved == false } }
    private var pendingRequests: [SignupRequest] { requests.filter { $0.status == "pending" } }
    private var reviewed: [SignupRequest] { requests.filter { $0.status != "pending" } }

    var body: some View {
        List {
            if let b = banner {
                Section { Text(b).font(.callout) }
            }
            if !held.isEmpty {
                Section {
                    ForEach(held) { heldRow($0) }
                } header: {
                    Text("Held members (\(held.count))")
                } footer: {
                    Text("Self-enrolled via Apple/Google — they can already use their own lists, but stay off the roster until approved.")
                }
            }
            if !pendingRequests.isEmpty {
                Section("Pending requests (\(pendingRequests.count))") {
                    ForEach(pendingRequests) { pendingRow($0) }
                }
            }
            if !reviewed.isEmpty {
                Section("Processed — hide when done") {
                    ForEach(reviewed) { reviewedRow($0) }
                }
            }
            dupeSections
            Section("Members") {
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
        .confirmationDialog(
            "Merge accounts?",
            isPresented: Binding(get: { mergePlan != nil }, set: { if !$0 { mergePlan = nil } }),
            titleVisibility: .visible,
            presenting: mergePlan
        ) { plan in
            Button("Merge \(plan.sources.joined(separator: ", ")) into \(plan.target)", role: .destructive) {
                Task { await runMerge(plan) }
            }
        } message: { plan in
            Text("Their shows, emails, phones, and Apple/Google sign-in move to \(plan.target) (untouched starter shows and exact duplicate titles are dropped); signed-in devices switch over; the duplicate account is deleted. This cannot be undone.")
        }
        .confirmationDialog(
            "Not duplicates?",
            isPresented: Binding(get: { ignorePlan != nil }, set: { if !$0 { ignorePlan = nil } }),
            titleVisibility: .visible,
            presenting: ignorePlan
        ) { plan in
            Button("Ignore this match") { Task { await runIgnore(plan) } }
        } message: { plan in
            Text(plan.message)
        }
        .alert(
            "Reject \(rejectTarget?.fullName ?? "request")?",
            isPresented: Binding(get: { rejectTarget != nil }, set: { if !$0 { rejectTarget = nil } }),
            presenting: rejectTarget
        ) { r in
            TextField("Optional note (kept for your records)", text: $rejectNote)
            Button("Reject", role: .destructive) {
                let note = rejectNote
                rejectNote = ""
                Task { await act(r, action: "reject", notes: note) }
            }
            Button("Cancel", role: .cancel) { rejectNote = "" }
        } message: { _ in
            Text("The note is not sent to the requester.")
        }
    }

    // ---- New-members queue (moved here from the retired New members screen) ----

    @ViewBuilder private func heldRow(_ m: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(m.personName).font(.body)
            Text(heldContact(m)).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button {
                    Task { await approveHeld(m) }
                } label: {
                    Label("Approve", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .tint(.green)
                Spacer()
                if workingSlug == m.slug { ProgressView() }
            }
            .disabled(workingSlug != nil)
        }
        .padding(.vertical, 2)
    }

    private func heldContact(_ m: AdminMember) -> String {
        var parts: [String] = ["@\(m.slug)"]
        if let via = m.enrolledVia, !via.isEmpty { parts.append("via \(via)") }
        if let email = m.emails.first { parts.append(email) }
        return parts.joined(separator: " · ")
    }

    private func approveHeld(_ m: AdminMember) async {
        workingSlug = m.slug
        defer { workingSlug = nil }
        banner = nil
        do {
            let res = try await API.approveMember(slug: m.slug)
            if let e = res.error { banner = "Couldn't approve: \(e)" }
            else { banner = "Approved \(m.personName)" }
            await load()
        } catch {
            banner = "Network error. Try again."
        }
    }

    @ViewBuilder private func pendingRow(_ r: SignupRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(r.fullName).font(.body)
            contactLinks(email: r.email, phone: r.phone)
            // The /join form's "how do you know Patrick" answer — often the
            // deciding signal, so it shows right on the card like the web.
            if let s = r.source, !s.isEmpty {
                Text(s)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 6))
            }
            HStack(spacing: 12) {
                Button {
                    Task { await act(r, action: "approve") }
                } label: {
                    Label("Approve", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .tint(.green)
                Button(role: .destructive) {
                    rejectTarget = r
                } label: {
                    Label("Reject", systemImage: "xmark.circle")
                }
                .buttonStyle(.borderless)
                Spacer()
                if working == r.id { ProgressView() }
            }
            .disabled(working != nil)
        }
        .padding(.vertical, 2)
    }

    // mailto:/tel: links so a tap starts the conversation, like the web card.
    @ViewBuilder private func contactLinks(email: String?, phone: String?) -> some View {
        HStack(spacing: 14) {
            if let e = email, !e.isEmpty, let u = URL(string: "mailto:\(e)") {
                Link(e, destination: u)
            }
            if let p = phone, !p.isEmpty,
               let u = URL(string: "tel:\(p.replacingOccurrences(of: " ", with: ""))") {
                Link(p, destination: u)
            }
        }
        .font(.caption)
    }

    // Processed rows carry a Hide: dismisses the request for good (the
    // server stops returning it), so the queue empties once handled.
    // Approved rows keep the welcome intro handy until hidden.
    @ViewBuilder private func reviewedRow(_ r: SignupRequest) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(r.fullName).font(.body)
            HStack(spacing: 6) {
                Text(r.status.capitalized)
                    .foregroundStyle(r.status == "approved" ? .green : .secondary)
                if let s = r.createdMemberSlug { Text("· @\(s)") }
                if let by = r.reviewedBy, !by.isEmpty { Text("· by \(by)") }
                Spacer()
                if working == r.id {
                    ProgressView()
                } else {
                    Button("Hide") { Task { await act(r, action: "hide") } }
                        .buttonStyle(.borderless)
                        .disabled(working != nil)
                }
            }
            .font(.caption)
            if let n = r.notes, !n.isEmpty {
                Text(n).font(.caption).foregroundStyle(.secondary)
            }
            if r.status == "approved", let slug = r.createdMemberSlug {
                WelcomeIntroPanel(
                    slug: slug,
                    displayName: r.fullName.split(separator: " ").first.map(String.init) ?? slug,
                    phone: r.phone)
            }
        }
    }

    private func act(_ r: SignupRequest, action: String, notes: String? = nil) async {
        working = r.id
        defer { working = nil }
        banner = nil
        do {
            let trimmed = notes?.trimmingCharacters(in: .whitespacesAndNewlines)
            let res = try await API.actOnSignupRequest(
                id: r.id, action: action,
                notes: (trimmed?.isEmpty ?? true) ? nil : trimmed)
            if let e = res.error {
                banner = "Couldn't \(action): \(e)"
            } else if action == "approve" {
                banner = "Approved \(r.fullName)" + (res.created?.slug.map { " → @\($0)" } ?? "")
            } else if action == "reject" {
                banner = "Rejected \(r.fullName)"
            }
            await load()
        } catch {
            banner = "Network error. Try again."
        }
    }

    // ---- Possible duplicates (mirrors the web panel) ----
    //
    // Two heuristics: (1) accounts reachable only through an Apple private-
    // relay address (the "Hide My Email" signup path — near-certain
    // duplicates), and (2) two members sharing a first name. Anything the
    // heuristics miss can be merged with the manual picker.

    struct MergePlan: Identifiable {
        let sources: [String]
        let target: String
        var id: String { sources.joined(separator: ",") + ">" + target }
    }

    struct IgnorePlan: Identifiable {
        let pairs: [[String]]
        let message: String
        var id: String { pairs.flatMap { $0 }.joined(separator: "|") }
    }

    private func isRelayOnly(_ m: AdminMember) -> Bool {
        if !m.emails.isEmpty {
            return m.emails.allSatisfy { $0.lowercased().hasSuffix("@privaterelay.appleid.com") }
        }
        // No email at all only happens for external-identity signups.
        return (m.enrolledVia?.isEmpty == false) && m.phones.isEmpty
    }

    private func pairKey(_ a: String, _ b: String) -> String {
        [a, b].sorted().joined(separator: "|")
    }

    private var ignoredPairs: Set<String> {
        Set(ignores.map { pairKey($0.slugA, $0.slugB) })
    }

    private func pairIgnored(_ a: String, _ b: String) -> Bool {
        ignoredPairs.contains(pairKey(a, b))
    }

    // Same-first-name groups (minus fully-ignored pairings) and lone
    // hidden-email-only accounts, ordered stably by name.
    private var dupeGroups: (groups: [[AdminMember]], loneRelays: [AdminMember]) {
        var byFirst: [String: [AdminMember]] = [:]
        for m in members {
            let key = (m.firstName ?? m.slug).trimmingCharacters(in: .whitespaces).lowercased()
            byFirst[key, default: []].append(m)
        }
        let groups = byFirst.sorted { $0.key < $1.key }.map(\.value)
            .map { g in g.filter { m in g.contains { o in o.slug != m.slug && !pairIgnored(m.slug, o.slug) } } }
            .filter { $0.count > 1 }
        let grouped = Set(groups.flatMap { $0 }.map(\.slug))
        // A self-pair ignore silences the "hidden email only" flag.
        let loneRelays = members.filter {
            isRelayOnly($0) && !grouped.contains($0.slug) && !pairIgnored($0.slug, $0.slug)
        }
        return (groups, loneRelays)
    }

    // Ignores whose members still exist (merges/deletions leave stale rows).
    private var shownIgnores: [DupeIgnore] {
        let slugs = Set(members.map(\.slug))
        return ignores.filter { slugs.contains($0.slugA) && slugs.contains($0.slugB) }
    }

    // Default keeper: a real (non-relay) account, preferring the bigger
    // library, then the older login history.
    private func defaultKeep(_ group: [AdminMember]) -> String {
        let ranked = group.sorted { a, b in
            let ra = isRelayOnly(a) ? 1 : 0, rb = isRelayOnly(b) ? 1 : 0
            if ra != rb { return ra < rb }
            if (a.showCount ?? 0) != (b.showCount ?? 0) { return (a.showCount ?? 0) > (b.showCount ?? 0) }
            return (a.lastLogin ?? "~") < (b.lastLogin ?? "~")
        }
        return ranked.first?.slug ?? ""
    }

    private func groupKey(_ group: [AdminMember]) -> String {
        group.map(\.slug).sorted().joined(separator: "|")
    }

    @ViewBuilder private var dupeSections: some View {
        let (groups, loneRelays) = dupeGroups
        if !groups.isEmpty || !loneRelays.isEmpty || !shownIgnores.isEmpty {
            Section {
                Group {
                    ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                        groupBlock(group)
                    }
                    ForEach(loneRelays) { loneRelayBlock($0) }
                    manualMergeRow
                    if !shownIgnores.isEmpty { ignoredBlock }
                }
                .disabled(merging)
            } header: {
                Text("Possible duplicates")
            } footer: {
                Text("Merging moves the duplicate's shows, emails, phones, and Apple/Google sign-in to the kept account, switches their signed-in devices over, and deletes the duplicate. It cannot be undone. Ignoring a match hides it permanently (until un-ignored).")
            }
        }
    }

    @ViewBuilder private func groupBlock(_ group: [AdminMember]) -> some View {
        let key = groupKey(group)
        let keep = keepChoice[key] ?? defaultKeep(group)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(group) { m in
                Button {
                    keepChoice[key] = m.slug
                } label: {
                    dupeCandidateRow(m, selected: m.slug == keep)
                }
                .buttonStyle(.plain)
            }
            HStack(spacing: 14) {
                Button("Merge the other\(group.count > 2 ? "s" : "") into kept", role: .destructive) {
                    let sources = group.map(\.slug).filter { $0 != keep }
                    mergePlan = MergePlan(sources: sources, target: keep)
                }
                Button("Not duplicates") {
                    let slugs = group.map(\.slug)
                    var pairs: [[String]] = []
                    for a in slugs.indices {
                        for b in slugs.indices where b > a { pairs.append([slugs[a], slugs[b]]) }
                    }
                    ignorePlan = IgnorePlan(
                        pairs: pairs,
                        message: "Ignore the match between \(slugs.joined(separator: " and "))? They won't be flagged as possible duplicates of each other again.")
                }
            }
            .font(.callout.weight(.semibold))
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func dupeCandidateRow(_ m: AdminMember, selected: Bool) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("Keep \(m.personName)").fontWeight(selected ? .semibold : .regular)
                    Text("@\(m.slug)").font(.caption).foregroundStyle(.secondary)
                }
                Text(dupeDetail(m)).font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // Library size + last login: a hidden-email duplicate that logged in
    // yesterday next to a real account with a stale login is exactly how
    // the operator tells which is which.
    private func dupeDetail(_ m: AdminMember) -> String {
        var parts: [String] = []
        if let via = m.enrolledVia, !via.isEmpty { parts.append("via \(via)") }
        if m.emails.isEmpty { parts.append("no email") }
        else if isRelayOnly(m) { parts.append("hidden email") }
        else { parts.append(m.emails.joined(separator: ", ")) }
        let c = m.showCount ?? 0
        parts.append("\(c) own show\(c == 1 ? "" : "s")")
        parts.append(lastLoginText(m.lastLogin))
        return parts.joined(separator: " · ")
    }

    @ViewBuilder private func loneRelayBlock(_ m: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(m.personName)
                    Text("@\(m.slug)").font(.caption).foregroundStyle(.secondary)
                    Text("hidden email only")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.red)
                }
                Text(dupeDetail(m)).font(.caption).foregroundStyle(.secondary)
            }
            memberPickerRow("Merge into", selection: Binding(
                get: { loneTarget[m.slug] ?? "" },
                set: { loneTarget[m.slug] = $0 }
            ), excluding: m.slug)
            HStack(spacing: 14) {
                Button("Merge", role: .destructive) {
                    guard let target = loneTarget[m.slug], !target.isEmpty else { return }
                    mergePlan = MergePlan(sources: [m.slug], target: target)
                }
                .disabled((loneTarget[m.slug] ?? "").isEmpty)
                Button("Not a duplicate") {
                    ignorePlan = IgnorePlan(
                        pairs: [[m.slug, m.slug]],
                        message: "Stop flagging \(m.slug) as a hidden-email-only account?")
                }
            }
            .font(.callout.weight(.semibold))
            .buttonStyle(.borderless)
        }
        .padding(.vertical, 4)
    }

    // Manual fallback for pairs the heuristics don't spot. Each picker gets a
    // full-width labeled row — a single horizontal row truncates the pickers
    // to a few characters on iPhone widths.
    @ViewBuilder private var manualMergeRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Manual merge").font(.caption).foregroundStyle(.secondary)
            memberPickerRow("Duplicate", selection: $manualSource)
            memberPickerRow("Merge into", selection: $manualTarget)
            Button("Merge duplicate into kept account", role: .destructive) {
                mergePlan = MergePlan(sources: [manualSource], target: manualTarget)
            }
            .font(.callout.weight(.semibold))
            .buttonStyle(.borderless)
            .disabled(manualSource.isEmpty || manualTarget.isEmpty || manualSource == manualTarget)
        }
        .padding(.vertical, 2)
    }

    // A labeled, full-width picker row listing every member by name + slug.
    // The menu keeps the trailing value readable because it owns the whole
    // row width instead of sharing one line with buttons and other pickers.
    @ViewBuilder private func memberPickerRow(
        _ label: String, selection: Binding<String>, excluding: String? = nil
    ) -> some View {
        HStack {
            Text(label).font(.callout)
            Spacer()
            Picker(label, selection: selection) {
                Text("choose member…").tag("")
                ForEach(members.filter { $0.slug != excluding }) {
                    Text("\($0.personName) (@\($0.slug))").tag($0.slug)
                }
            }
            .labelsHidden()
        }
    }

    @ViewBuilder private var ignoredBlock: some View {
        DisclosureGroup("\(shownIgnores.count) ignored match\(shownIgnores.count == 1 ? "" : "es")") {
            ForEach(shownIgnores) { r in
                HStack {
                    Text(r.slugA == r.slugB
                         ? "\(r.slugA) (hidden-email flag)"
                         : "\(r.slugA) ↔ \(r.slugB)")
                        .font(.caption)
                    Spacer()
                    Button("Un-ignore") {
                        Task { await runIgnore(IgnorePlan(pairs: [[r.slugA, r.slugB]], message: ""), ignoring: false) }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
                }
            }
        }
        .font(.callout)
    }

    private func runMerge(_ plan: MergePlan) async {
        merging = true
        defer { merging = false }
        banner = nil
        var done: [String] = []
        do {
            for source in plan.sources {
                let r = try await API.mergeMember(source: source, target: plan.target)
                if let e = r.error {
                    banner = "Merging \(source) failed: \(friendlyAdminError(e))"
                    break
                }
                let moved = r.showsMoved ?? 0
                var line = "\(source) → \(plan.target): \(moved) show\(moved == 1 ? "" : "s") moved"
                if let d = r.duplicateShowsDropped, d > 0 {
                    line += ", \(d) duplicate title\(d == 1 ? "" : "s") dropped"
                }
                done.append(line)
            }
            if !done.isEmpty { banner = "Merged. " + done.joined(separator: " · ") }
        } catch {
            banner = "Network error. Try again."
        }
        manualSource = ""; manualTarget = ""
        await load()
    }

    private func runIgnore(_ plan: IgnorePlan, ignoring: Bool = true) async {
        banner = nil
        do {
            let r = try await API.setDupeIgnores(pairs: plan.pairs, ignoring: ignoring)
            if let e = r.error { banner = friendlyAdminError(e) }
            await load()
        } catch {
            banner = "Network error. Try again."
        }
    }

    // ---- Roster ----

    @ViewBuilder private func memberRow(_ m: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(m.personName).font(.body)
                if m.isAdmin == true { statusTag("ADMIN", .blue) }
                if m.disabled == true { statusTag("DISABLED", .red) }
                if m.approved == false { statusTag("PENDING", .orange) }
            }
            Text(contactSummary(m)).font(.caption).foregroundStyle(.secondary)
            Text(lastActivityText(m.lastActivityAt)).font(.caption).foregroundStyle(.secondary)
            activityPills(m)
            platformBadges(m)
        }
        .opacity(m.disabled == true ? 0.6 : 1)
    }

    // Every platform the member has ever used, side by side like the
    // activity pills above them — dim when unused, filled when earned.
    // "Ever used" (not a recent window): once lit, a badge stays lit.
    private static let platformBadgeOrder: [(String, String)] = [
        ("iphone", "iPhone"),
        ("ipad", "iPad"),
        ("watchos", "Apple Watch"),
        ("mac", "Mac"),
        ("tvos", "Apple TV"),
        ("web-small", "Small Web"),
        ("web-large", "Large Web"),
    ]

    @ViewBuilder private func platformBadges(_ m: AdminMember) -> some View {
        let used = Set(m.platforms ?? [])
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(Self.platformBadgeOrder, id: \.0) { key, label in
                    Text(label)
                        .font(.caption2.weight(.medium))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(
                            used.contains(key) ? Color.accentColor.opacity(0.15) : Color.clear,
                            in: Capsule())
                        .overlay(Capsule().stroke(Color.secondary.opacity(0.25), lineWidth: used.contains(key) ? 0 : 1))
                        .foregroundStyle(used.contains(key) ? Color.accentColor : Color.secondary.opacity(0.45))
                }
            }
        }
    }

    // Per-list 30-day adds, colour-coded to the list like the web roster's
    // pills; a quiet italic line when there's been nothing.
    @ViewBuilder private func activityPills(_ m: AdminMember) -> some View {
        if let a = m.activity30d {
            let items: [(String, Int, Color)] = [
                ("Watching", a.watching, .green),
                ("Awaiting", a.waiting, .blue),
                ("Loved", a.recommending, .purple),
                ("Next Up", a.next, .orange),
            ].filter { $0.1 > 0 }
            if items.isEmpty {
                Text("no list activity in the last 30 days")
                    .font(.caption2).italic().foregroundStyle(.secondary)
            } else {
                HStack(spacing: 4) {
                    Text("30d:").font(.caption2).foregroundStyle(.secondary)
                    ForEach(items, id: \.0) { item in
                        Text("\(item.0) \(item.1)")
                            .font(.caption2.weight(.medium))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(item.2.opacity(0.15), in: Capsule())
                            .foregroundStyle(item.2)
                    }
                }
            }
        }
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
        requests = (try? await API.signupRequests()) ?? []
        ignores = (try? await API.dupeIgnores()) ?? []
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
    case "cannot_merge_admin": return "The duplicate is an admin — remove their admin role first."
    case "cannot_merge_demo": return "The demo account can't be part of a merge."
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

func lastLoginText(_ iso: String?) -> String {
    guard let iso, let d = parseServerDate(iso) else { return "never logged in" }
    return "last login \(relTime(d))"
}

private struct MemberDetailAdminView: View {
    let member: AdminMember
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var firstName: String
    @State private var lastName: String
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
        _firstName = State(initialValue: member.firstName ?? "")
        _lastName = State(initialValue: member.lastName ?? "")
        _emails = State(initialValue: member.emails.joined(separator: ", "))
        _phones = State(initialValue: member.phones.joined(separator: ", "))
        _isDisabled = State(initialValue: member.disabled ?? false)
        _isApproved = State(initialValue: member.approved ?? true)
        _isAdmin = State(initialValue: member.isAdmin ?? false)
    }

    var body: some View {
        Form {
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
