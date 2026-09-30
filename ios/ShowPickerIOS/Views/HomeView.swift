import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    // Trending draws ten on launch and fetches the rest only if asked. Home is
    // the launch screen, so the default stays small; expandedTrending is a
    // one-way switch per session so a pull-to-refresh doesn't collapse a list
    // the member deliberately opened.
    @State private var expandedTrending = false
    @State private var expandingTrending = false
    // Session-derived state (here just the unrated count behind the "Rate My
    // Shows" badge) in one value that clears itself on logout — the same type
    // the iPad/Mac sidebar uses. See ShowPickerCore/SessionScope.swift.
    @State private var session = SessionScope()
    @State private var loading = true
    // Roster fetch threw — shown only when there's nothing to display, so an
    // empty Members section reads as a load failure, not an empty club.
    @State private var loadFailed = false
    @State private var showingLogin = false
    @State private var showingDeleteAccount = false
    @State private var showingPasskeys = false
    @State private var showingConnectedApps = false
    @State private var showingExport = false
    @State private var showingSearch = false
    @State private var shakePick: Show?
    @State private var path: [Route] = []
    // Universal link that arrived before the roster loaded (cold launch);
    // replayed by load().
    @State private var pendingLink: URL?
    // "NEW" beside Groups until the member opens it once. A badge that never
    // clears is just decoration — this one has a job and then goes away.
    @AppStorage("seenGroups") private var seenGroups = false
    // The ranking changed in 2026-09 (ratings lead). Opening the screen once
    // retires the flag — FavoriteActorsView writes the same key.
    @AppStorage(FavoriteActorsView.seenUpdateKey) private var seenFavoriteActorsUpdate = false
    // Set after accepting a household invite from a link, so the app says
    // something happened rather than silently changing an audit total.
    @State private var showingHouseholdJoined = false
    @State private var showingImport = false

    // The logged-in member, resolved against the loaded member list.
    private var myMember: Member? {
        guard let slug = auth.memberSlug else { return nil }
        return members.first { $0.slug == slug }
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                HStack {
                    Text("Show Picker Club")
                        .font(.largeTitle.bold())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Spacer()
                    Button {
                        showingSearch = true
                    } label: {
                        Image(systemName: "magnifyingglass").font(.title3)
                    }
                    .accessibilityLabel("Search")
                    .padding(.trailing, 4)
                    accountControl
                }
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 8)

                OfflineBanner()

                List {
                    // One nav group: My Shows leads, then the rest in the
                    // same order as the web nav and the iPad sidebar —
                    // Groups, Rate My Shows, Subscription Audit, Vibe,
                    // Calendar. Trending is the content section
                    // below rather than a row, same as the web at phone
                    // width. (Admin lives behind the account icon.)
                    Section {
                        if let me = myMember {
                            NavigationLink(value: Route.member(me)) {
                                Label("My Shows", systemImage: "person.crop.circle")
                                    .font(.body.weight(.semibold))
                            }
                        } else if !auth.isLoggedIn {
                            // A bare login row tells someone who just
                            // installed the app nothing about what they'd be
                            // logging into. Trending below is browsable
                            // without an account; this says what an account
                            // adds.
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Keep track of what you're watching")
                                    .font(.headline)
                                Text("Four lists — Watching, Awaiting, Loved and Next Up — with premiere dates, ratings and where to watch. Make a group to see what your people are watching, and audit what you're paying for.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(.vertical, 4)
                            // One button, because the sheet is identifier-first
                            // and works out whether you're new or returning on
                            // its own. Two buttons to the same destination only
                            // asked people to classify themselves before
                            // anything had happened. The label matches the
                            // sheet's own title, so a returning member taps
                            // "Log in or sign up" and lands on a screen that
                            // says the same thing.
                            Button {
                                showingLogin = true
                            } label: {
                                Label("Log in or sign up",
                                      systemImage: "rectangle.portrait.and.arrow.forward")
                            }
                            Text("Browse what the club is watching below — no account needed.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        if myMember != nil {
                            NavigationLink(value: Route.groups) {
                                HStack(spacing: 8) {
                                    Label("Groups", systemImage: "person.2.fill")
                                    if !seenGroups { NewFlag() }
                                }
                            }
                            // What's coming up on your own lists, with the
                            // subscribe button on it. This used to fire
                            // webcal:// straight at the OS, which was a dead
                            // end for anyone who didn't want a subscription.
                            NavigationLink(value: Route.calendar) {
                                Label("Calendar", systemImage: "calendar")
                            }
                            NavigationLink {
                                RateBacklogView()
                            } label: {
                                HStack(spacing: 8) {
                                    Label("Rate My Shows", systemImage: "star.fill")
                                    if session.backlogCount > 0 { CountFlag(count: session.backlogCount) }
                                }
                            }
                            NavigationLink {
                                SubscriptionAuditView()
                            } label: {
                                Label("Subscription Audit", systemImage: "creditcard")
                            }
                            // Sits with the other reads of your own library
                            // rather than near Trending: these are YOUR
                            // actors, not the club's.
                            NavigationLink(value: Route.favoriteActors) {
                                HStack(spacing: 8) {
                                    Label("Favorite Actors", systemImage: "person.2.fill")
                                    if !seenFavoriteActorsUpdate { NewFlag(text: "UPDATED") }
                                }
                            }
                        }
                        // Vibe is personal: logged-in members only, opening
                        // their own vibe.
                        if let me = myMember {
                            NavigationLink {
                                VibeView(initialSlug: me.slug)
                            } label: {
                                Label("Vibe", systemImage: "sparkles")
                            }
                        }
                    }
                    // Home is the launch screen, so a member who just signed
                    // up sees this before they ever reach My Shows. An empty
                    // library is the one moment where importing a list they
                    // already keep is the most useful thing on offer; the
                    // card goes away as soon as they have anything.
                    // nil (logged out, or a roster without counts) means no card.
                    if (myMember?.showCount ?? 1) == 0 {
                        Section {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Start with a list you already have")
                                    .font(.headline)
                                Text("Notes, a text file, an old spreadsheet — paste it in and we'll sort the titles onto your four lists.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            .padding(.vertical, 4)
                            Button {
                                showingImport = true
                            } label: {
                                Label("Paste a list", systemImage: "doc.on.clipboard")
                            }
                        }
                    }
                    // Say why the shelf is bare instead of hiding it: a
                    // failed fetch and a genuinely quiet month look identical
                    // when the section just disappears.
                    if !popular.isEmpty || !loading {
                        Section("Trending") {
                            if popular.isEmpty {
                                Text(loadFailed
                                     ? "Couldn't load trending shows — pull down to try again."
                                     : "Nothing trending yet.")
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(popular) { show in
                                NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                                    popularRow(show)
                                }
                            }
                            // Only offered when the shelf is actually full —
                            // a nine-row Trending has nothing more to show,
                            // and a "More" that returns the same nine reads
                            // as a bug.
                            if !expandedTrending && popular.count >= trendingPageSize {
                                Button {
                                    Task { await expandTrending() }
                                } label: {
                                    HStack {
                                        Text("More")
                                        if expandingTrending {
                                            Spacer()
                                            ProgressView()
                                        }
                                    }
                                }
                                .disabled(expandingTrending)
                            }
                        }
                    }
                    // Attribution required by the TMDB API terms; OMDb credited
                    // alongside since IMDb ratings come through it.
                    Section {
                        Text("Ratings and metadata from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await load() }
                .task { if loading { await load() } }
                .overlay { if loading && members.isEmpty { ProgressView() } }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .member(let m):
                    MemberView(member: m)
                case .adminMemberDetail(let slug):
                    MemberAdminDetailLoader(slug: slug)
                case .detail(let id, let title, let network, let rating):
                    ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
                case .pick(let title, let network, let rating, let posterUrl, let networkUrl):
                    ShowDetailView(id: nil, initialTitle: title, initialNetwork: network,
                                   initialRating: rating, initialPoster: posterUrl, initialNetworkUrl: networkUrl)
                case .groups:
                    GroupsListView(path: $path)
                        .onAppear { seenGroups = true }
                case .groupDetail(let id):
                    GroupDetailView(groupId: id)
                case .calendar:
                    if let me = myMember { CalendarView(member: me) }
                case .favoriteActors:
                    FavoriteActorsView()
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
            .sheet(isPresented: $showingDeleteAccount) {
                DeleteAccountView().environmentObject(auth)
            }
            .sheet(isPresented: $showingPasskeys) {
                PasskeysView().environmentObject(auth)
            }
            .sheet(isPresented: $showingConnectedApps) {
                ConnectedAppsView()
            }
            .sheet(isPresented: $showingExport) {
                ExportListsView().environmentObject(auth)
            }
            .sheet(isPresented: $showingLogin) {
                LoginView().environmentObject(auth)
            }
            // Reload on dismiss so the roster's show counts (and this card's
            // own visibility) reflect what was just imported.
            .sheet(isPresented: $showingImport, onDismiss: { Task { await load() } }) {
                ImportListView { await load() }
            }
            .alert("You're in the household", isPresented: $showingHouseholdJoined) {
                Button("OK", role: .cancel) { }
            } message: {
                Text("Your shows and theirs now count together in Subscription audit.")
            }
            .sheet(isPresented: $showingSearch) {
                SearchView().environmentObject(auth)
            }
            .sheet(item: $shakePick) { pick in
                ShakePickView(show: pick).environmentObject(auth)
            }
            .onShake { Task { await handleShake() } }
            // Menu-bar and hardware-keyboard commands (⌘F, ⌘R on Mac Catalyst
            // and an iPad with a keyboard).
            .onAppCommand(.showSearchCommand) { showingSearch = true }
            .onAppCommand(.refreshCommand) { Task { await load() } }
            // A link that needed a session (a group invite) waits for one
            // rather than being dropped when the login sheet takes over.
            .onChange(of: auth.memberSlug) { _, slug in
                // Logging out from a pushed screen — a member's lists, the
                // calendar, an admin tool — would otherwise leave it on screen
                // 401-ing, the same stale-nav problem the iPad sidebar had.
                // The nav rows themselves are gated on `myMember`, so they
                // clear on their own; the stack and the badge don't.
                if slug == nil {
                    path = []
                    session.clear()
                    return
                }
                // Signing in has to refetch the roster, because `myMember` is
                // resolved out of it. Someone who just signed up wasn't in the
                // copy we loaded before they had an account, so My Shows,
                // Groups, Calendar, Rate My Shows, Subscription Audit and Vibe
                // all stay hidden until the next cold launch — Home looks like
                // Trending and nothing else. load() replays any parked link
                // once the fresh roster lands, so the pendingLink handling
                // moves inside it rather than racing the stale copy.
                Task { await load() }
            }
            // The other half of the parked-link rule: a link that arrived
            // before auth resolved has been waiting. If the answer turns out
            // to be "logged out", ask now — nothing else will, because
            // memberSlug never changed.
            .onChange(of: auth.resolved) { _, done in
                if done && auth.memberSlug == nil && pendingLink != nil {
                    showingLogin = true
                }
            }
            // Universal links (a shared showpicker.club/<member> URL tapped in
            // Messages, Mail, etc.) arrive one of two ways depending on launch
            // state, so handle both.
            .onOpenURL { route(url: $0) }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL { route(url: url) }
            }
        }
    }

    // Route a showpicker.club URL to the matching screen: /show/<id> (widget
    // taps) opens that show's card, /<slug> opens that member's lists,
    // anything else stays on Home. On a cold
    // launch the roster may not be loaded yet — park member URLs and replay
    // them when load() lands (show links need no roster at all).
    //
    // `allowRefetch` bounds that replay to one attempt: load() replays with it
    // false, so a slug that still doesn't resolve against a freshly fetched
    // roster (a stale bookmark, a typo) gives up instead of looping.
    @MainActor
    private func route(url: URL, allowRefetch: Bool = true) {
        // A page the website owns (Claude's sign-in, the privacy policy)
        // reaching the app through a stale universal-link cache: give it back
        // to the browser instead of silently staying on Home.
        if WebOnlyLinks.isWebOnly(url) { BrowserHandoff.open(url); return }
        guard let first = url.path.split(separator: "/").first.map({ String($0).lowercased() }) else { return }
        if let show = Route.showLink(url) { path = [show]; return }
        // A household invite (/household/join?code=…). Same shape as a group
        // invite: accepting IS the navigation, and it lands on the audit the
        // household actually affects.
        if first == "household" {
            if let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty {
                Task { await joinHousehold(code, link: url) }
            }
            return
        }
        // A group invite (/groups/join?token=…) is the whole point of the
        // share link, so joining IS the navigation: accept the token, then
        // land on the group. Already a member (409) still opens the group.
        if first == "groups" {
            if let token = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "token" })?.value, !token.isEmpty {
                Task { await joinFromInvite(token, link: url) }
            } else {
                path = [.groups]
            }
            return
        }
        let slug = first
        // An admin following a link to someone else lands on that member's
        // admin screen, not their lists. The link that matters is the signup
        // notification email's, and the question it raises — who is this, and
        // are they using it? — is answered there. Your own slug is still just
        // your page, and a non-admin only ever gets the member page.
        if auth.isAdmin && !auth.isMe(slug) && members.contains(where: { $0.slug == slug }) {
            path = [.adminMemberDetail(slug: slug)]
            return
        }
        if let m = members.first(where: { $0.slug == slug }) {
            path = [.member(m)]
        } else if members.isEmpty {
            // Cold launch: load() is already in flight and replays this.
            pendingLink = url
        } else if allowRefetch {
            // The roster we hold predates this member. That is the normal case
            // for the link that matters most — the signup notification email
            // points at someone who by definition didn't exist when this copy
            // was fetched — and dropping it here is why that button appeared to
            // do nothing but leave you on Home. Refetch once, then replay.
            pendingLink = url
            Task { await load() }
        }
    }

    // Accept a group invite and land on the group. Logged out, the token is
    // parked and replayed once the session resolves — the invite is what
    // brought them here, so losing it to the login sheet would waste the tap.
    // A failed join (expired token, or already a member — the endpoint answers
    // 409 without a body we read) still lands on Groups rather than nowhere.
    @MainActor
    private func joinFromInvite(_ token: String, link: URL) async {
        guard auth.memberSlug != nil else {
            // Park it either way. Prompt only once we actually know there is
            // no session: on a cold launch this runs before auth.refresh()
            // lands, and the onChange below replays the link the moment it
            // does — or prompts, if it resolves to logged-out.
            pendingLink = link
            if auth.resolved { showingLogin = true }
            return
        }
        do {
            switch try await API.joinGroup(token: token) {
            // Already in it is not a failure: the link still means "look at
            // this group", so it still lands there.
            case .joined(let id), .alreadyMember(let id):
                path = [.groups, .groupDetail(id)]
            case .dead:
                path = [.groups]
                ErrorCenter.shared.explain("That invite link has expired or been used up. Ask whoever sent it for a new one.")
            // The session expired between opening the link and redeeming it.
            // Park the link and replay it after signing in, the same as
            // tapping one while logged out.
            case .notSignedIn:
                pendingLink = link
                showingLogin = true
            case .failed:
                path = [.groups]
                ErrorCenter.shared.report("join the group")
            }
        } catch {
            // Transport failure — offline, most likely. Not a dead link, so
            // don't say it is.
            path = [.groups]
            ErrorCenter.shared.report("join the group")
        }
    }

    // Accept a household invite, then show the audit — the screen where the
    // pooled shows visibly change. Logged out, the code parks and replays
    // once the session resolves, same as a group invite.
    @MainActor
    private func joinHousehold(_ code: String, link: URL) async {
        guard let me = myMember else {
            pendingLink = link
            if auth.resolved && !auth.isLoggedIn { showingLogin = true }
            return
        }
        // A dead or already-used invite used to land on the "you're in!"
        // screen anyway, because the failure was swallowed.
        let joined = await ErrorCenter.run("join the household", { _ = try await API.joinHousehold(code: code) })
        guard joined else { return }
        path = [.member(me)]
        showingHouseholdJoined = true
    }

    // Easter egg: a shake surfaces a random show from the logged-in member's
    // own Next Up list. Silent if you're logged out or your Next Up is empty.
    @MainActor
    private func handleShake() async {
        guard let slug = auth.memberSlug, shakePick == nil else { return }
        let mine = (try? await API.shows(member: slug)) ?? []
        let upNext = mine.filter { $0.list == ShowList.next.rawValue && !$0.isArchived }
        if let pick = upNext.randomElement() {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            shakePick = pick
        }
    }

    // "1.4.1 (24) · 8784b9a" — version, build, and the commit the binary was
    // built from. GitCommit is stamped into Info.plist by the "Stamp git
    // commit" build phase; it reads "unknown" if the source isn't a git
    // checkout, and the whole suffix is dropped rather than showing that to
    // someone who installed from the App Store, where it would be noise.
    static var buildIdentifier: String {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        let sha = info?["GitCommit"] as? String ?? ""
        let base = "\(version) (\(build))"
        return sha.isEmpty || sha == "unknown" ? base : "\(base) · \(sha)"
    }

    // Account control shown on the title line: a menu (Log out) when signed in,
    // otherwise a tap target that opens the login sheet.
    private var accountControl: some View {
        Group {
            if auth.isLoggedIn {
                Menu {
                    Button {
                        showingPasskeys = true
                    } label: {
                        Label("Passkeys…", systemImage: "person.badge.key")
                    }
                    // AI apps connected through the MCP server, and the
                    // in-app way to disconnect one (ConnectedAppsView).
                    Button {
                        showingConnectedApps = true
                    } label: {
                        Label("Connected Apps…", systemImage: "link")
                    }
                    // The permanent way in. The Home card and the My Shows
                    // nudges are onboarding prompts that retire themselves once
                    // a library fills up, which left an established member with
                    // no route to import at all — even though the endpoint's
                    // ceiling is per-day, i.e. built to be used again.
                    Button {
                        showingImport = true
                    } label: {
                        Label("Paste a List…", systemImage: "doc.on.clipboard")
                    }
                    Button {
                        showingExport = true
                    } label: {
                        Label("Export My Lists…", systemImage: "square.and.arrow.up")
                    }
                    // Operator tools sit behind the account icon so Home reads
                    // the same for an admin as it does for everyone else.
                    if auth.isAdmin {
                        Section("Admin") {
                            Button {
                                path.append(.adminReporting)
                            } label: {
                                Label("Reporting", systemImage: "chart.bar.xaxis")
                            }
                            Button {
                                path.append(.adminMembers)
                            } label: {
                                Label("Manage Members", systemImage: "person.2.badge.gearshape")
                            }
                            Button {
                                path.append(.adminUrlCleanup)
                            } label: {
                                Label("Show Cleanup", systemImage: "link.badge.plus")
                            }
                            Button {
                                path.append(.adminVibe)
                            } label: {
                                Label("Vibe Trait Scoring", systemImage: "sparkles")
                            }
                        }
                    }
                    Button(role: .destructive) {
                        Task { await auth.logout() }
                    } label: {
                        Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                    Button(role: .destructive) {
                        showingDeleteAccount = true
                    } label: {
                        Label("Delete Account…", systemImage: "trash")
                    }
                    // Which build this actually is. The version and build
                    // number alone can't answer that during testing — several
                    // different binaries ship as the same "1.4.1 (24)" before
                    // a release is cut — so the commit is stamped in at build
                    // time and shown here. Disabled: it's a readout, not an
                    // action, and this menu is where the other things you only
                    // want occasionally already live.
                    Divider()
                    Button {} label: { Text(Self.buildIdentifier) }
                        .disabled(true)
                } label: {
                    Image(systemName: "person.crop.circle").font(.title)
                }
                .accessibilityLabel("Account")
            } else {
                Button {
                    showingLogin = true
                } label: {
                    Image(systemName: "person.crop.circle").font(.title)
                }
                .accessibilityLabel("Log in")
            }
        }
    }

    private func popularRow(_ s: PopularShow) -> some View {
        ShowRow(s)
    }

    private func memberRow(_ m: Member) -> some View {
        HStack {
            Text(m.label)
            Spacer()
            if m.activeCount > 0 {
                Text("\(m.activeCount) active").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // The server's own default page. Kept here so the "More" button's
    // appearance and the fetch agree on what "a full shelf" means.
    private let trendingPageSize = 10
    private let trendingMaxSize = 50

    private func expandTrending() async {
        expandingTrending = true
        defer { expandingTrending = false }
        guard let more = try? await API.popular(limit: trendingMaxSize) else { return }
        popular = more
        expandedTrending = true
    }

    private func load() async {
        loading = true
        defer { loading = false }
        async let m = try? await API.members()
        async let p = try? await API.popular()
        let mr = await m
        let pr = await p
        loadFailed = (mr == nil)
        // Most recently active first, then most active (Watching + Next Up +
        // Loved) as the tiebreaker — the same roster order as the iPad and web.
        // On failure keep the previous roster — stale beats blank.
        members = (mr ?? members).sorted {
            let la = $0.lastActivityAt ?? "", lb = $1.lastActivityAt ?? ""
            if la != lb { return la > lb }
            return $0.activeCount > $1.activeCount
        }
        // A refresh while expanded refetches the expanded page, so pulling
        // down doesn't silently drop the member back to ten rows.
        popular = pr ?? popular
        if expandedTrending, let more = try? await API.popular(limit: trendingMaxSize) {
            popular = more
        }
        session.backlogCount = auth.isLoggedIn ? ((try? await API.rateBacklogCount()) ?? 0) : 0
        if let link = pendingLink {
            pendingLink = nil
            route(url: link, allowRefetch: false)
        }
    }
}

// "NEW" set against the label it flags rather than the row's trailing edge.
// `.badge()` parks it at the far right in secondary grey, where it reads as a
// count and disappears into the row; this sits it right after the word and
// gives it the accent so it actually catches the eye. Shared by the iPhone
// Home list and the iPad sidebar. Each use carries its own seen key —
// `seenGroups` for Groups, `seenFavoriteActorsUpdate` for the UPDATED flag on
// Favorite Actors — and opening that screen once retires it for good.
struct NewFlag: View {
    var text = "NEW"

    var body: some View {
        Text(text)
            .font(.caption2.weight(.black))
            .kerning(0.4)
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2.5)
            .background(Capsule().fill(Color.accentColor))
            .accessibilityLabel(text.capitalized)
    }
}

// How many of your shows still have no rating — the whole reason to tap that
// row. Same treatment as NewFlag and for the same reason: `.badge()` put it
// at the far right in secondary grey, alongside the chevron, where it read as
// an ornament rather than as the number you're being asked to work down.
struct CountFlag: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.caption.weight(.bold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(Capsule().fill(Color.accentColor))
            .accessibilityLabel("\(count) unrated")
    }
}

// Nav routes. Hashable for NavigationStack value links.
enum Route: Hashable {
    // showpicker.club/show/<id>?title=… — the home-screen widgets' tap-through
    // link — parsed to the detail route it opens. nil for any other URL. The
    // title just gives the card something to draw before its own fetch lands.
    static func showLink(_ url: URL) -> Route? {
        let parts = url.path.split(separator: "/").map(String.init)
        guard parts.count >= 2, parts[0].lowercased() == "show", let id = Int(parts[1]) else { return nil }
        let title = URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "title" })?.value ?? ""
        return .detail(id: id, title: title, network: nil, rating: nil)
    }

    case member(Member)
    // One member's admin screen, addressed by slug because the only thing
    // that pushes it from outside Manage Members — the signup notification
    // email's link to /<slug> — has a slug and nothing else.
    case adminMemberDetail(slug: String)
    case detail(id: Int, title: String, network: String?, rating: String?)
    // A recommendation ("Picks for you") has no backing show row yet — open the
    // detail from its title so the user chooses a list, rather than adding it
    // silently.
    case pick(title: String, network: String?, rating: String?, posterUrl: String?, networkUrl: String?)
    case groups
    case groupDetail(Int)
    // Admin screens live in the account menu rather than on Home, so they
    // push by value: a Button inside a Menu can append to the path, while a
    // NavigationLink inside a Menu doesn't push at all.
    case calendar
    // Derived from the member's own library, so it needs no argument — the
    // session decides whose actors these are.
    case favoriteActors
    case adminReporting
    case adminMembers
    case adminUrlCleanup
    case adminVibe
}
