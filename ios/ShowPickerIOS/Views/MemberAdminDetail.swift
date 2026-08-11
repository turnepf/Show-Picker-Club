import SwiftUI

// The admin-only picture of a member: who this person is, how they got in,
// what they've used the app from, and what they've actually added lately.
//
// It sits at the top of the admin member screen (Admin ▸ Manage members ▸ a
// member) rather than on the member's own page. It was on the member page
// briefly, and that was the wrong place: the point of opening someone's page
// is to see what they see, and a header full of their phone numbers isn't
// what they see. The member page is now theirs, unaltered; this is the
// operator's view of them, and the two link to each other.
//
// Session-derived by construction (see docs/INVARIANTS.md §2): the whole
// admin screen is only reachable from an admin session, so a logout tears
// this view — and every byte of contact detail it loaded — out of the
// hierarchy rather than leaving it on screen for a session that no longer
// exists. The `guard` in `load()` is the second, independent check.
struct MemberAdminDetail: View {
    /// The row the admin screen already holds. Everything but recent adds is
    /// read straight off it — no second fetch for what the caller has.
    let member: AdminMember

    @EnvironmentObject private var auth: AuthStore
    @State private var activity: [ActivityItem] = []
    @State private var loading = true

    private let recentLimit = 8

    var body: some View {
        Group {
            Section {
                identityBlock(member)
            } header: {
                Text("Admin")
            }

            Section {
                if activity.isEmpty {
                    Text(loading ? "Loading…" : "\(member.personName) hasn't added anything yet.")
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
        .task { await load() }
    }

    @ViewBuilder private func identityBlock(_ d: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(d.personName).font(.body)
                if d.isAdmin == true { tag("ADMIN", .blue) }
                if d.disabled == true { tag("DISABLED", .red) }
            }
            Text(joinedText(d)).font(.caption).foregroundStyle(.secondary)
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
            // The four lists across. Server-counted on the same terms as the
            // library line below, so the two can't disagree.
            AdminActivityPills(activity: d.listCounts, prefix: "lists:", showZeros: true)
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
        let total = d.listCounts.map { $0.watching + $0.waiting + $0.recommending + $0.next }
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
    // request — the endpoint would 403 anyway, but this must not depend on
    // that to stay empty.
    private func load() async {
        guard auth.isAdmin else {
            activity = []
            loading = false
            return
        }
        loading = true
        defer { loading = false }
        activity = (try? await API.activity(member: member.slug, limit: recentLimit)) ?? activity
    }
}

// Fetches the admin row for a slug and hands it to the admin member screen.
// The signup notification email deep-links to /<slug>, which carries a slug
// and nothing else; an admin following it wants this screen, not the member's
// list of shows. Also the fallback for a link that arrives before the roster.
struct MemberAdminDetailLoader: View {
    let slug: String

    @EnvironmentObject private var auth: AuthStore
    @State private var member: AdminMember?
    @State private var loading = true

    var body: some View {
        Group {
            if let m = member {
                MemberDetailAdminView(member: m) { await load() }
            } else if loading {
                ProgressView()
            } else {
                ContentUnavailableView("Couldn't load \(slug)",
                                       systemImage: "person.crop.circle.badge.exclamationmark",
                                       description: Text("Pull up Admin ▸ Manage members to try again."))
            }
        }
        .task { if member == nil { await load() } }
    }

    private func load() async {
        guard auth.isAdmin else { loading = false; return }
        loading = true
        defer { loading = false }
        member = (try? await API.adminMember(slug: slug)) ?? member
    }
}

// Every platform the member has ever used, side by side — dim when unused,
// filled when earned. "Ever used" (not a recent window): once lit, a badge
// stays lit. Shared by the Manage Members roster rows and the admin member
// screen's detail block so the two can't drift apart.
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
// member screen both show 30-day *adds* (zeros dropped, because a list nobody
// touched isn't news), and that screen also shows all-time list *totals* —
// where a zero is the news, so `showZeros` keeps them.
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
