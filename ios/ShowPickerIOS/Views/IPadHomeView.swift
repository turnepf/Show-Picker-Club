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
    case whatsNew
    case vibe
    case subscriptionAudit
    // Admin sub-tools. The sidebar's Admin row is a disclosure accordion
    // whose entries mirror the iPhone AdminView's options, each opening its
    // screen in the detail column.
    case adminReporting
    case adminCreateMember
    case adminManageMembers
    case adminNewMembers
    case adminUrlCleanup
    case adminVibe
}

struct IPadHomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.openURL) private var openURL
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true
    @State private var selection: SidebarItem?
    // Whose lists the sidebar's list entries show. Defaults to the logged-in
    // member once auth resolves; tapping a member row moves focus to them.
    @State private var focusedSlug: String?
    @State private var showingLogin = false
    @State private var showingDeleteAccount = false
    @State private var showingSearch = false

    private let memberRowHeight: CGFloat = 38
    private let memberWindowRows = 5
    // Admin accordion expansion; opens automatically when an admin tool is in
    // focus (e.g. after a detail-column reset) so the current page stays visible.
    @State private var adminExpanded = false
    private let joinURL = URL(string: "https://showpicker.club/join")!

    private var myMember: Member? {
        guard let slug = auth.memberSlug else { return nil }
        return members.first { $0.slug == slug }
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
            NavigationStack {
                detailRoot
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
            }
            .id(detailKey)
        }
        .task { if loading { await load() } }
        .sheet(isPresented: $showingLogin) { LoginView().environmentObject(auth) }
        .sheet(isPresented: $showingDeleteAccount) { DeleteAccountView().environmentObject(auth) }
        .sheet(isPresented: $showingSearch) { SearchView().environmentObject(auth) }
        // Auth may resolve after the member list loads; land on your Watching
        // list once it does (unless the user has already picked something).
        .onChange(of: auth.memberSlug) { _, _ in applyInitialSelection() }
        // Keep the Admin accordion open whenever one of its tools is selected.
        .onChange(of: selection) { _, sel in
            if sel.map(isAdminItem) == true { adminExpanded = true }
        }
    }

    private func isAdminItem(_ item: SidebarItem) -> Bool {
        switch item {
        case .adminReporting, .adminCreateMember, .adminManageMembers,
             .adminNewMembers, .adminUrlCleanup, .adminVibe:
            return true
        default:
            return false
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
                    Button { showingLogin = true } label: {
                        Label("Log in to see your shows", systemImage: "person.crop.circle.badge.plus")
                    }
                }
            }
            // Discovery + account group, kept separate from the member lists
            // above: Trending, What's New, Subscription audit, then Admin.
            Section {
                if !popular.isEmpty {
                    Label("Trending", systemImage: "flame")
                        .tag(SidebarItem.trending)
                }
                whatsNewRow
                Label("Vibe", systemImage: "sparkles")
                    .tag(SidebarItem.vibe)
                // Your own premiere/finale calendar feed — the token only comes
                // back for the logged-in member's own row, so the row hides
                // without one.
                if let me = myMember, let token = me.calendarToken {
                    Button {
                        let enc = me.slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? me.slug
                        if let url = URL(string: "webcal://showpicker.club/calendar/\(enc).ics?key=\(token)") {
                            openURL(url)
                        }
                    } label: {
                        Label("Calendar", systemImage: "calendar.badge.plus")
                    }
                }
                // Subscription audit is personal, so it only appears once you're
                // signed in — matching the web sidebar and your own MemberView.
                if myMember != nil {
                    Label("Subscription audit", systemImage: "creditcard")
                        .tag(SidebarItem.subscriptionAudit)
                }
                if auth.isAdmin {
                    DisclosureGroup(isExpanded: $adminExpanded) {
                        Label("Reporting", systemImage: "chart.bar.xaxis")
                            .tag(SidebarItem.adminReporting)
                        Label("Create member", systemImage: "person.badge.plus")
                            .tag(SidebarItem.adminCreateMember)
                        Label("Manage members", systemImage: "person.2.badge.gearshape")
                            .tag(SidebarItem.adminManageMembers)
                        Label("New members", systemImage: "tray.and.arrow.down")
                            .tag(SidebarItem.adminNewMembers)
                        Label("Show Cleanup", systemImage: "link.badge.plus")
                            .tag(SidebarItem.adminUrlCleanup)
                        Label("Vibe trait scoring", systemImage: "sparkles")
                            .tag(SidebarItem.adminVibe)
                        ShareLink(item: joinURL,
                                  subject: Text("Show Picker Club"),
                                  message: Text("Join Show Picker Club")) {
                            Label("Sign-up link", systemImage: "square.and.arrow.up")
                        }
                    } label: {
                        Label("Admin", systemImage: "wrench.and.screwdriver")
                    }
                }
            }
            if !members.isEmpty {
                Section("Members") {
                    membersWindow
                        .listRowInsets(EdgeInsets())
                }
            }
            // Attribution required by the TMDB API terms; OMDb credited too.
            Section {
                Text("Ratings and metadata from IMDb (via OMDb) and TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.")
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
    private var whatsNewRow: some View {
        Label("What's New", systemImage: "sparkles")
            .tag(SidebarItem.whatsNew)
    }

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
                ForEach(members) { m in memberRow(m) }
            }
        }
        .frame(height: memberWindowHeight)
    }

    private var memberWindowHeight: CGFloat {
        let visible = min(CGFloat(members.count), CGFloat(memberWindowRows))
        let peek: CGFloat = members.count > memberWindowRows ? memberRowHeight / 2 : 0
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
            case .whatsNew:
                WhatsNewView()
            case .vibe:
                if let slug = auth.memberSlug ?? members.first?.slug {
                    VibeView(initialSlug: slug)
                } else {
                    placeholder("No members yet.", "sparkles")
                }
            case .subscriptionAudit:
                SubscriptionAuditView()
            case .adminReporting:
                ReportingView().environmentObject(auth)
            case .adminCreateMember:
                CreateMemberView().environmentObject(auth)
            case .adminManageMembers:
                ManageMembersView().environmentObject(auth)
            case .adminNewMembers:
                SignupRequestsView().environmentObject(auth)
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
        case .whatsNew:
            WhatsNewView()
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

    private func load() async {
        loading = true
        defer { loading = false }
        async let m = try? await API.members()
        async let p = try? await API.popular()
        let mr = (await m) ?? []
        let pr = (await p) ?? []
        // Most recently active first (the window shows the top five), then most
        // shows as the tiebreaker.
        members = mr.sorted {
            let la = $0.lastActivityAt ?? "", lb = $1.lastActivityAt ?? ""
            if la != lb { return la > lb }
            return $0.activeCount > $1.activeCount
        }
        popular = pr
        applyInitialSelection()
    }
}

// Trending list for the iPad detail column — mirrors the iPhone Home
// "Trending" section, opening each show in the detail stack.
private struct TrendingListView: View {
    let shows: [PopularShow]

    var body: some View {
        List(shows) { s in
            NavigationLink(value: Route.detail(id: s.id, title: s.title, network: s.network, rating: s.rating)) {
                HStack(spacing: 12) {
                    PosterThumb(url: s.posterUrl)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(s.title)
                        if let n = s.network, !n.isEmpty {
                            Text(n).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if let r = s.rating, !r.isEmpty {
                        Label(r, systemImage: "star.fill")
                            .font(.caption)
                            .labelStyle(.titleAndIcon)
                            .foregroundStyle(.orange)
                    }
                }
            }
        }
        .navigationTitle("Trending")
    }
}
