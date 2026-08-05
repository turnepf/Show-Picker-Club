import SwiftUI

// Purpose-built iPad layout: a compact persistent sidebar beside a detail
// column that reuses the same MemberView and ShowDetailView screens the iPhone
// uses. The sidebar leads with the four show lists (Watching, Awaiting,
// Loved, Next Up) for whichever member is in focus — you by default —
// so the segmented list picker isn't needed on iPad. Members live in a short
// scrolling window (top five by recent activity visible); tapping one refocuses
// the lists on them.
//
// iPhone keeps the single-stack HomeView untouched — RootView switches by
// device idiom.

// What the sidebar can point at. The show lists apply to the focused member,
// which is tracked separately so switching members keeps the same list open.
enum SidebarItem: Hashable {
    case list(ShowList)
    case trending
    case groups
    case vibe
    case subscriptionAudit
    case rateBacklog
    case calendar
    // Admin tools shown directly in the menu when user is an admin
    case adminReporting
    case adminManageMembers
    case adminUrlCleanup
    case adminVibe
}

struct IPadHomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    // Unrated count for the "Rate my backlog" badge. 0 draws no badge.
    @State private var backlogCount = 0
    @State private var loading = true
    // Roster fetch threw — shown only when there's nothing to display, so an
    // empty roster reads as a load failure, not an empty club.
    @State private var loadFailed = false
    // Slugs of members I share at least one group with. Empty until the
    // groups load (or for a member in no groups), which is the honest answer:
    // no groups, nobody else's lists to browse.
    @State private var groupMemberSlugs: Set<String> = []
    @State private var selection: SidebarItem?
    // Whose lists the sidebar's list entries show. Defaults to the logged-in
    // member once auth resolves; tapping a member row moves focus to them.
    @State private var focusedSlug: String?
    // Universal link that arrived before the roster loaded; replayed by load().
    @State private var pendingLink: URL?
    // Pushes on the detail column's stack. Owned here (not by the
    // NavigationStack) so widget deep links can push a show card directly;
    // cleared whenever detailKey resets the stack, matching the old behavior.
    @State private var detailPath: [Route] = []
    @State private var showingLogin = false
    @State private var showingDeleteAccount = false
    @State private var showingSearch = false
    @State private var showingExport = false
    // Same "NEW" badge as iPhone Home, cleared by opening Groups once.
    @AppStorage("seenGroups") private var seenGroups = false

    private let memberRowHeight: CGFloat = 38
    private let memberWindowRows = 5

    private var myMember: Member? {
        guard let slug = auth.memberSlug else { return nil }
        return members.first { $0.slug == slug }
    }

    // The roster, filtered to people I'm in a group with — plus me, since the
    // window is also how I get back to my own lists.
    private var groupMembers: [Member] {
        members.filter { $0.slug == auth.memberSlug || groupMemberSlugs.contains($0.slug) }
    }

    private var focusedMember: Member? {
        guard let slug = focusedSlug else { return nil }
        return members.first { $0.slug == slug }
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationTitle("Show Picker Club")
                // Roughly a quarter narrower than the stock iPad sidebar; the
                // detail column gets the reclaimed width.
                .navigationSplitViewColumnWidth(min: 220, ideal: 240, max: 260)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button { showingSearch = true } label: {
                            Image(systemName: "magnifyingglass")
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) { accountControl }
                }
        } detail: {
            // The detail column is its own stack so MemberView's NavigationLinks
            // (to show detail, Vibe, etc.) push here. The id resets it to the
            // section root whenever the sidebar choice or focused member changes.
            NavigationStack(path: $detailPath) {
                detailRoot
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
            }
            .id(detailKey)
        }
        .task { if loading { await load() } }
        .onChange(of: detailKey) { _, _ in detailPath = [] }
        .sheet(isPresented: $showingLogin) { LoginView().environmentObject(auth) }
        .sheet(isPresented: $showingDeleteAccount) { DeleteAccountView().environmentObject(auth) }
        .sheet(isPresented: $showingSearch) { SearchView().environmentObject(auth) }
        .sheet(isPresented: $showingExport) { ExportListsView().environmentObject(auth) }
        // Auth may resolve after the member list loads; land on your Watching
        // list once it does (unless the user has already picked something).
        .onChange(of: auth.memberSlug) { _, _ in applyInitialSelection() }
        // Universal links: focus the linked member in the sidebar. The web
        // keeps the open tab in the URL fragment (#recommending etc.), so a
        // shared link can land on the exact list.
        .onOpenURL { route(url: $0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { route(url: url) }
        }
    }


    // Distinguishes both "which section" and "whose lists" so switching members
    // rebuilds the detail stack even when the same list stays selected.
    private var detailKey: String {
        "\(String(describing: selection))|\(focusedSlug ?? "")"
    }

    // MARK: Sidebar

    private var sidebar: some View {
        List(selection: $selection) {
            // One-tap way home while browsing someone else's lists. The lists
            // section below re-points at whoever is focused, so without this
            // there's no visible route back to your own shows (your row in the
            // Members window may even be scrolled out of view).
            if let me = myMember, focusedSlug != me.slug {
                Section {
                    Button {
                        focusedSlug = me.slug
                        // Keep the open list open, matching the member rows.
                        if case .list = selection {} else { selection = .list(.watching) }
                    } label: {
                        Label("Back to My Shows", systemImage: "person.crop.circle")
                    }
                }
            }
            if focusedMember != nil {
                Section(listsHeader) {
                    ForEach(ShowList.allCases) { l in
                        Label(l.title, systemImage: listIcon(l))
                            .tag(SidebarItem.list(l))
                    }
                }
            } else if !auth.isLoggedIn && !loading {
                Section {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Keep track of what you're watching")
                            .font(.headline)
                        Text("Four lists — Watching, Awaiting, Loved and Next Up — with premiere dates, ratings and where to watch. Make a group to see what your people are watching, and audit what you're paying for.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 4)
                    Button { showingLogin = true } label: {
                        Label("Create your free account", systemImage: "person.crop.circle.badge.plus")
                    }
                    // Same sheet — identifier-first, so it handles both — but
                    // a returning member shouldn't have to read "create an
                    // account" and guess it signs them in too.
                    Button { showingLogin = true } label: {
                        Label("Already a member? Log in",
                              systemImage: "rectangle.portrait.and.arrow.forward")
                    }
                }
            }
            // Same group as the lists above rather than a separate one —
            // the gap read as a divide the nav doesn't actually have. Order
            // matches the web sidebar and iPhone Home: Groups, Trending,
            // Rate my backlog, Subscription audit, Vibe, Calendar, What's
            // New, then Admin.
            Group {
                if myMember != nil {
                    Label("Groups", systemImage: "person.2.fill")
                        .badge(seenGroups ? nil : Text("NEW"))
                        .tag(SidebarItem.groups)
                }
                if !popular.isEmpty {
                    Label("Trending", systemImage: "flame")
                        .tag(SidebarItem.trending)
                }
                // Subscription audit and Rate my backlog are personal, so they
                // only appear once you're signed in — matching the web sidebar
                // and your own MemberView.
                if myMember != nil {
                    Label("Rate my shows", systemImage: "star.fill")
                        .tag(SidebarItem.rateBacklog)
                        .badge(backlogCount)
                    Label("Subscription audit", systemImage: "creditcard")
                        .tag(SidebarItem.subscriptionAudit)
                    // Vibe is personal too: opens the member's own vibe.
                    Label("Vibe", systemImage: "sparkles")
                        .tag(SidebarItem.vibe)
                }
                // What's coming up on your lists, with the subscribe button
                // on the screen itself rather than firing webcal:// from the
                // sidebar at someone who may not want a subscription.
                if myMember != nil {
                    Label("Calendar", systemImage: "calendar")
                        .tag(SidebarItem.calendar)
                }
            }
            // People, not the club: the members you share a group with. The
            // iPhone dropped its roster outright, but here the list IS the
            // control that picks whose lists the detail column shows, so it
            // gets scoped rather than removed — same boundary as Trending,
            // search and Vibe.
            if !groupMembers.isEmpty {
                Section("Your groups") {
                    membersWindow
                        .listRowInsets(EdgeInsets())
                }
            }
            // Attribution required by the TMDB API terms; OMDb credited too.
            Section {
                Text("Ratings and metadata from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        // Inset-grouped cards rather than the flat `.sidebar` source-list style,
        // so each section (My Shows / the discovery group / Members) reads as a
        // distinct card the way it does in the web desktop split view
        // (styles.css `.ios-group`). All large-screen surfaces share this
        // sectioned sidebar vocabulary — see DESIGN.md §6 (Platform parity).
        .listStyle(.insetGrouped)
        .overlay { if loading && members.isEmpty { ProgressView() } }
        .refreshable { await load() }
    }

    // Lives in the discovery group beneath the member lists, rather than in
    // the account menu.
    private var listsHeader: String {
        guard let m = focusedMember else { return "Shows" }
        return auth.isMe(m.slug) ? "My Shows" : "\(m.label)'s Shows"
    }

    private func listIcon(_ l: ShowList) -> String {
        switch l {
        case .watching:     return "play.circle"
        case .waiting:      return "hourglass"
        case .recommending: return "hand.thumbsup"
        case .next:         return "text.badge.plus"
        }
    }

    // A fixed-height window over the member roster: the five most recently
    // active members are visible, the rest scroll within the window. When more
    // exist, a half row peeks out at the bottom to hint at the scroll.
    private var membersWindow: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if members.isEmpty && loadFailed {
                    Text("Couldn't load the club — check the connection and relaunch.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 8)
                }
                ForEach(groupMembers) { m in memberRow(m) }
            }
        }
        .frame(height: memberWindowHeight)
    }

    private var memberWindowHeight: CGFloat {
        let count = groupMembers.count
        let visible = min(CGFloat(count), CGFloat(memberWindowRows))
        let peek: CGFloat = count > memberWindowRows ? memberRowHeight / 2 : 0
        return visible * memberRowHeight + peek
    }

    private func memberRow(_ m: Member) -> some View {
        Button {
            focusedSlug = m.slug
            // Keep the open list open when refocusing; otherwise land on Watching.
            if case .list = selection {} else { selection = .list(.watching) }
        } label: {
            HStack {
                Text(m.label).lineLimit(1)
                Spacer()
                if m.activeCount > 0 {
                    Text("\(m.activeCount)").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: memberRowHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            focusedSlug == m.slug ? Color.accentColor.opacity(0.15) : Color.clear,
            in: RoundedRectangle(cornerRadius: 8)
        )
    }

    private var accountControl: some View {
        Group {
            if auth.isLoggedIn {
                Menu {
                    Button {
                        showingExport = true
                    } label: {
                        Label("Export My Lists…", systemImage: "square.and.arrow.up")
                    }
                    // Operator tools behind the account icon, same as iPhone,
                    // so the sidebar reads the same for an admin as for
                    // everyone else. Selecting rather than pushing: the iPad's
                    // detail column is driven by the sidebar selection.
                    if auth.isAdmin {
                        Section("Admin") {
                            Button { selection = .adminReporting } label: {
                                Label("Reporting", systemImage: "chart.bar.xaxis")
                            }
                            Button { selection = .adminManageMembers } label: {
                                Label("Manage members", systemImage: "person.2.badge.gearshape")
                            }
                            Button { selection = .adminUrlCleanup } label: {
                                Label("Show Cleanup", systemImage: "link.badge.plus")
                            }
                            Button { selection = .adminVibe } label: {
                                Label("Vibe trait scoring", systemImage: "sparkles")
                            }
                        }
                    }
                    Button(role: .destructive) {
                        Task { await auth.logout() }
                    } label: {
                        Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    Button(role: .destructive) {
                        showingDeleteAccount = true
                    } label: {
                        Label("Delete Account…", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "person.crop.circle")
                }
            } else {
                Button { showingLogin = true } label: {
                    Image(systemName: "person.crop.circle")
                }
            }
        }
    }

    // MARK: Detail column

    @ViewBuilder private var detailRoot: some View {
        if let selection {
            switch selection {
            case .list(let l):
                if let m = focusedMember {
                    MemberView(member: m, fixedList: l)
                } else {
                    placeholder("Pick a member to see their lists.", "person.crop.circle")
                }
            case .trending:
                TrendingListView(shows: popular)
            case .groups:
                GroupsListView(path: $detailPath)
                    .onAppear { seenGroups = true }
            case .vibe:
                if let slug = auth.memberSlug {
                    VibeView(initialSlug: slug)
                } else {
                    placeholder("Log in to see your vibe.", "sparkles")
                }
            case .subscriptionAudit:
                SubscriptionAuditView()
            case .rateBacklog:
                RateBacklogView()
            case .calendar:
                if let me = myMember {
                    CalendarView(member: me)
                } else {
                    placeholder("Log in to see what's coming up.", "calendar")
                }
            case .adminReporting:
                ReportingView().environmentObject(auth)
            case .adminManageMembers:
                ManageMembersView().environmentObject(auth)
            case .adminUrlCleanup:
                UrlCleanupView().environmentObject(auth)
            case .adminVibe:
                VibeAdminView().environmentObject(auth)
            }
        } else {
            placeholder("Pick a list or Trending from the sidebar.", "sidebar.left")
        }
    }

    @ViewBuilder private func destination(_ route: Route) -> some View {
        switch route {
        case .member(let m):
            MemberView(member: m)
        case .detail(let id, let title, let network, let rating):
            ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
        case .pick(let title, let network, let rating, let posterUrl, let networkUrl):
            ShowDetailView(id: nil, initialTitle: title, initialNetwork: network,
                           initialRating: rating, initialPoster: posterUrl, initialNetworkUrl: networkUrl)
        case .groups:
            GroupsListView(path: $detailPath)
        case .groupDetail(let id):
            GroupDetailView(groupId: id)
        // The iPad keeps its admin entries in the sidebar, but the routes
        // exist app-wide, so the switch has to answer for them.
        case .calendar:
            if let me = myMember { CalendarView(member: me) }
        case .adminReporting:
            ReportingView()
        case .adminMembers:
            ManageMembersView()
        case .adminUrlCleanup:
            UrlCleanupView()
        case .adminVibe:
            VibeAdminView()
        }
    }

    private func placeholder(_ text: String, _ symbol: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 46))
                .foregroundStyle(.secondary)
            Text(text)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func applyInitialSelection() {
        if focusedSlug == nil, let me = myMember {
            focusedSlug = me.slug
        }
        guard selection == nil else { return }
        if focusedSlug != nil {
            selection = .list(.watching)
        } else if !popular.isEmpty {
            selection = .trending
        }
    }

    // Who I share a group with. /api/groups gives my groups; each group's
    // detail gives its members. Non-fatal by design: on failure the window
    // shows just me, which is wrong-but-safe, where falling back to the full
    // roster would be exactly the thing we removed.
    private func loadGroupMembers() async {
        guard auth.isLoggedIn else { groupMemberSlugs = []; return }
        guard let groups = try? await API.groups().groups else { return }
        var slugs: Set<String> = []
        for group in groups {
            if let detail = try? await API.groupDetail(id: group.id) {
                for member in detail.members { slugs.insert(member.slug) }
            }
        }
        groupMemberSlugs = slugs
    }

    private func load() async {
        loading = true
        defer { loading = false }
        async let m = try? await API.members()
        async let p = try? await API.popular()
        let mr = await m
        let pr = await p
        loadFailed = (mr == nil)
        // Most recently active first (the window shows the top five), then most
        // shows as the tiebreaker. On failure keep the previous roster —
        // stale beats blank.
        members = (mr ?? members).sorted {
            let la = $0.lastActivityAt ?? "", lb = $1.lastActivityAt ?? ""
            if la != lb { return la > lb }
            return $0.activeCount > $1.activeCount
        }
        popular = pr ?? popular
        backlogCount = auth.isLoggedIn ? ((try? await API.rateBacklogCount()) ?? 0) : 0
        await loadGroupMembers()
        if let link = pendingLink {
            pendingLink = nil
            route(url: link)
        } else {
            applyInitialSelection()
        }
    }

    // Route a showpicker.club URL: /<slug> focuses that member (honoring the
    // #list fragment the web puts in shared URLs)
    // changelog. Cold-launch links wait for the roster via pendingLink.
    @MainActor
    private func route(url: URL) {
        guard let first = url.path.split(separator: "/").first.map({ String($0).lowercased() }) else { return }
        // Widget taps: push the show's card onto the detail column. Needs no
        // roster, and leaves the sidebar selection alone.
        if let show = Route.showLink(url) { detailPath = [show]; return }
        // Group invite: joining is the navigation. Selecting Groups first
        // means a failed join (expired token, already a member) still lands
        // somewhere useful.
        // Household invite: accept it and land on the audit the household
        // actually changes. iPhone has done this since the invite flow
        // shipped; the iPad silently ignored the link.
        if first == "household" {
            if let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty {
                Task {
                    _ = try? await API.joinHousehold(code: code)
                    selection = .subscriptionAudit
                }
            }
            return
        }
        if first == "groups" {
            selection = .groups
            if let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty {
                Task {
                    if let result = try? await API.joinGroup(token: token) {
                        detailPath = [.groupDetail(result.groupId)]
                    }
                }
            }
            return
        }
        let slug = first == "dorothy" ? "whitt" : first // mirror the web's 301
        if members.contains(where: { $0.slug == slug }) {
            focusedSlug = slug
            let frag = (url.fragment ?? "").lowercased()
            selection = .list(ShowList(rawValue: frag) ?? .watching)
        } else if members.isEmpty {
            pendingLink = url
        }
    }
}

// Trending list for the iPad detail column — mirrors the iPhone Home
// "Trending" section, opening each show in the detail stack.
private struct TrendingListView: View {
    let shows: [PopularShow]

    var body: some View {
        List(shows) { s in
            NavigationLink(value: Route.detail(id: s.id, title: s.title, network: s.network, rating: s.rating)) {
                ShowRow(s)
            }
        }
        .navigationTitle("Trending")
    }
}
