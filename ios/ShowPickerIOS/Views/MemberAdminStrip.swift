import SwiftUI

// The admin-only header on a member's page: who this person is, how they got
// in, what they've used the app from, and what they've actually added lately.
//
// It exists because of the signup notification email. That email's button is a
// universal link to /<slug>, so it opens the app on the new member — and what
// landed there was four lists of shows with no answer to the only question the
// email raises: who is this, and are they using it? That answer already
// existed in Manage Members, one screen and several taps away from where the
// question gets asked.
//
// Session-derived by construction (see docs/INVARIANTS.md §2): the caller
// renders this view only while `auth.isAdmin`, so a logout tears the whole
// view — and every byte of contact detail it loaded — out of the hierarchy
// rather than leaving it on screen for a session that no longer exists. The
// `guard` in `load()` is the second, independent check.
struct MemberAdminStrip: View {
    let slug: String
    /// The member's display name, for the "Recent adds" empty state.
    let label: String
    /// Per-list totals counted from the rows the page already loaded, so the
    /// header and the list under it can't disagree. nil until they land.
    let listCounts: MemberActivity?

    @EnvironmentObject private var auth: AuthStore
    // Collapsed/expanded persists across members and launches — see the
    // DisclosureGroup below for why it's collapsible at all.
    @AppStorage("adminStripExpanded") private var expanded = true
    @State private var detail: AdminMember?
    @State private var activity: [ActivityItem] = []
    @State private var loading = true
    // `Group` hands its modifiers to each child, so the `.task` below fires
    // once per Section in here. The fetch is idempotent rather than the layout
    // being contorted to host a single task.
    @State private var didLoad = false

    private let recentLimit = 8

    var body: some View {
        Group {
            // Always rendered, so there is a stable host for `.task` even
            // before (or without) a successful fetch.
            Section {
                if let d = detail {
                    // Collapsible because the iPad and Mac split view draws
                    // this above each of the four lists in turn — four copies
                    // of a tall header between you and the shows. Expanded by
                    // default (arriving from the notification email, the detail
                    // is the point) and the choice sticks.
                    DisclosureGroup(isExpanded: $expanded) {
                        identityBlock(d)
                        NavigationLink {
                            MemberDetailAdminView(member: d) { await load(force: true) }
                        } label: {
                            Label("Manage member", systemImage: "person.text.rectangle")
                        }
                    } label: {
                        summaryLine(d)
                    }
                } else {
                    Text(loading ? "Loading…" : "Couldn't load admin detail.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } header: {
                Text("Admin")
            }

            if detail != nil && expanded {
                Section {
                    if activity.isEmpty {
                        Text(loading ? "Loading…" : "\(label) hasn't added anything yet.")
                            .font(.callout).foregroundStyle(.secondary)
                    } else {
                        ForEach(activity) { item in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.text).font(.callout)
                                if let when = relativeServerTime(item.time) {
                                    Text(when).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Recent adds")
                } footer: {
                    if activity.count >= recentLimit {
                        Text("The \(recentLimit) most recent. Bulk adds are collapsed into one line.")
                    }
                }
            }
        }
        .task { await load() }
    }

    // The collapsed state still has to be worth reading: who, and whether
    // they're actually using it.
    @ViewBuilder private func summaryLine(_ d: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(d.personName).font(.body)
                if d.isAdmin == true { tag("ADMIN", .blue) }
                if d.disabled == true { tag("DISABLED", .red) }
            }
            Text(joinedText(d)).font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private func identityBlock(_ d: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("@\(d.slug)").font(.caption).foregroundStyle(.secondary)
            ForEach(d.emails, id: \.self) { e in
                Text(e).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(d.phones, id: \.self) { p in
                Text(p).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if d.emails.isEmpty && d.phones.isEmpty {
                Text("no email or phone on file — external identity only")
                    .font(.caption).italic().foregroundStyle(.secondary)
            }
            Text(lastLoginText(d.lastLogin, method: d.lastLoginMethod))
                .font(.caption).foregroundStyle(.secondary)
            Text(lastActivityText(d.lastActivityAt)).font(.caption).foregroundStyle(.secondary)
            // The four lists across, counted from the same rows drawn below —
            // so the header can't disagree with the list under it.
            AdminActivityPills(activity: listCounts, prefix: "lists:", showZeros: true)
            Text(libraryLine(d)).font(.caption).foregroundStyle(.secondary)
            AdminActivityPills(activity: d.activity30d)
            AdminPlatformBadges(platforms: d.platforms ?? [])
        }
        .padding(.vertical, 2)
    }

    // "joined 3d ago via apple" — what the notification email announced, in the
    // form that answers "is this the person who just signed up?". Either half
    // can be missing: `enrolled_via` is NULL for members who predate
    // self-enrollment, and an old server doesn't send `joined_at` at all.
    private func joinedText(_ d: AdminMember) -> String {
        let via = d.enrolledVia.flatMap { $0.isEmpty ? nil : $0 }
        switch (relativeServerTime(d.joinedAt), via) {
        case let (when?, via?): return "joined \(when) via \(via)"
        case let (when?, nil): return "joined \(when)"
        case let (nil, via?): return "joined via \(via)"
        default: return "join date unknown"
        }
    }

    private func libraryLine(_ d: AdminMember) -> String {
        let total = listCounts.map { $0.watching + $0.waiting + $0.recommending + $0.next }
            ?? (d.showCount ?? 0)
        var line = "\(total) show\(total == 1 ? "" : "s")"
        if let archived = d.archivedCount, archived > 0 {
            line += " · \(archived) archived"
        }
        return line
    }

    private func tag(_ text: String, _ color: Color) -> some View {
        Text(text).font(.caption2.weight(.semibold)).foregroundStyle(color)
    }

    // A non-admin session is answered with nothing at all rather than a failed
    // request — the endpoints would 403 anyway, but the strip must not depend
    // on that to stay hidden.
    private func load(force: Bool = false) async {
        guard auth.isAdmin else {
            detail = nil
            activity = []
            loading = false
            return
        }
        if didLoad && !force { return }
        didLoad = true
        loading = true
        defer { loading = false }
        // Failures leave the strip out entirely: it's decoration on someone
        // else's page, and a half-drawn admin header is worse than none.
        detail = (try? await API.adminMember(slug: slug)) ?? detail
        activity = (try? await API.activity(member: slug, limit: recentLimit)) ?? activity
    }
}

// Every platform the member has ever used, side by side — dim when unused,
// filled when earned. "Ever used" (not a recent window): once lit, a badge
// stays lit. Shared by the Manage Members roster rows and the member page's
// admin strip so the two can't drift apart.
let adminPlatformBadgeOrder: [(String, String)] = [
    ("iphone", "iPhone"),
    ("ipad", "iPad"),
    ("watchos", "Apple Watch"),
    ("mac", "Mac"),
    ("tvos", "Apple TV"),
    ("web-small", "Small Web"),
    ("web-large", "Large Web"),
]

struct AdminPlatformBadges: View {
    let platforms: [String]

    var body: some View {
        let used = Set(platforms)
        FlowLayout(spacing: 4) {
            ForEach(adminPlatformBadgeOrder, id: \.0) { key, label in
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

// Per-list counts, colour-coded to the list like the web roster's pills; a
// quiet italic line when there's been nothing.
//
// Two callers, two readings of the same shape: the roster rows and the admin
// strip both show 30-day *adds* (zeros dropped, because a list nobody touched
// isn't news), and the strip also shows all-time list *totals* — where a zero
// is the news, so `showZeros` keeps them.
struct AdminActivityPills: View {
    let activity: MemberActivity?
    var prefix: String = "30d:"
    var showZeros = false

    var body: some View {
        if let a = activity {
            let items: [(String, Int, Color)] = [
                ("Watching", a.watching, .green),
                ("Awaiting", a.waiting, .blue),
                ("Loved", a.recommending, .purple),
                ("Next Up", a.next, .orange),
            ].filter { showZeros || $0.1 > 0 }
            if items.isEmpty {
                Text("no list activity in the last 30 days")
                    .font(.caption2).italic().foregroundStyle(.secondary)
            } else {
                HStack(spacing: 4) {
                    Text(prefix).font(.caption2).foregroundStyle(.secondary)
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
}
