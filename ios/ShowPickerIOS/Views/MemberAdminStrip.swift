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

    @EnvironmentObject private var auth: AuthStore
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
                    identityBlock(d)
                    NavigationLink {
                        MemberDetailAdminView(member: d) { await load(force: true) }
                    } label: {
                        Label("Manage member", systemImage: "person.text.rectangle")
                    }
                } else {
                    Text(loading ? "Loading…" : "Couldn't load admin detail.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            } header: {
                Text("Admin")
            }

            if detail != nil {
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

    @ViewBuilder private func identityBlock(_ d: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(d.personName).font(.body)
                Text("@\(d.slug)").font(.caption).foregroundStyle(.secondary)
                if d.isAdmin == true { tag("ADMIN", .blue) }
                if d.disabled == true { tag("DISABLED", .red) }
            }
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
            Text(signupLine(d)).font(.caption).foregroundStyle(.secondary)
            Text(lastActivityText(d.lastActivityAt)).font(.caption).foregroundStyle(.secondary)
            AdminActivityPills(activity: d.activity30d)
            AdminPlatformBadges(platforms: d.platforms ?? [])
        }
        .padding(.vertical, 2)
    }

    // "joined via apple · last login 3d ago via Apple". enrolled_via is how the
    // account was created (which is what the notification email announced);
    // last_login_method is how they get in now, and the two diverge as soon as
    // someone adds a passkey.
    private func signupLine(_ d: AdminMember) -> String {
        var parts: [String] = []
        if let via = d.enrolledVia, !via.isEmpty { parts.append("joined via \(via)") }
        parts.append(lastLoginText(d.lastLogin, method: d.lastLoginMethod))
        return parts.joined(separator: " · ")
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

// Per-list 30-day adds, colour-coded to the list like the web roster's pills;
// a quiet italic line when there's been nothing.
struct AdminActivityPills: View {
    let activity: MemberActivity?

    var body: some View {
        if let a = activity {
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
}
