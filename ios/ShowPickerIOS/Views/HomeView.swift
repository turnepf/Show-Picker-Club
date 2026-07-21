import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.openURL) private var openURL
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true
    // Roster fetch threw — shown only when there's nothing to display, so an
    // empty Members section reads as a load failure, not an empty club.
    @State private var loadFailed = false
    @State private var showingLogin = false
    @State private var showingDeleteAccount = false
    @State private var showingExport = false
    @State private var showingSearch = false
    @State private var showAllMembers = false
    @State private var shakePick: Show?
    @State private var path: [Route] = []
    // Auto-open the logged-in member's own list once per launch. Tracked so
    // tapping Back to Home doesn't immediately bounce them forward again.
    @State private var didAutoOpen = false
    // Universal link that arrived before the roster loaded (cold launch);
    // replayed by load().
    @State private var pendingLink: URL?

    private let memberPreviewCount = 6

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
                    .padding(.trailing, 4)
                    accountControl
                }
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 8)

                OfflineBanner()

                List {
                    if let me = myMember {
                        Section {
                            NavigationLink(value: Route.member(me)) {
                                Label("My Shows", systemImage: "person.crop.circle")
                                    .font(.body.weight(.semibold))
                            }
                        }
                    } else if !auth.isLoggedIn {
                        Section {
                            Button {
                                showingLogin = true
                            } label: {
                                Label("Log in to see your shows", systemImage: "person.crop.circle.badge.plus")
                            }
                        }
                    }
                    // Discovery + account group, separated from My Shows above:
                    // What's New, Vibe, Calendar + Subscription audit
                    // (personal), then Admin. Trending is its own content
                    // section further down.
                    Section {
                        whatsNewRow
                        // Vibe is personal: logged-in members only, opening
                        // their own vibe.
                        if let me = myMember {
                            NavigationLink {
                                VibeView(initialSlug: me.slug)
                            } label: {
                                Label("Vibe", systemImage: "sparkles")
                            }
                        }
                        // Your own premiere/finale feed. webcal:// makes iOS
                        // offer to add it as a subscription calendar; the token
                        // only comes back for the logged-in member's own row.
                        if let me = myMember, let token = me.calendarToken {
                            Button {
                                let enc = me.slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? me.slug
                                if let url = URL(string: "webcal://showpicker.club/calendar/\(enc).ics?key=\(token)") {
                                    openURL(url)
                                }
                            } label: {
                                // Buttons tint their whole label with the accent
                                // color; keep the title primary so the row matches
                                // the NavigationLinks around it.
                                Label {
                                    Text("Calendar").foregroundStyle(.primary)
                                } icon: {
                                    Image(systemName: "calendar.badge.plus")
                                }
                            }
                        }
                        if myMember != nil {
                            NavigationLink {
                                SubscriptionAuditView()
                            } label: {
                                Label("Subscription audit", systemImage: "creditcard")
                            }
                        }
                        if auth.isAdmin {
                            NavigationLink {
                                AdminView().environmentObject(auth)
                            } label: {
                                Label("Admin", systemImage: "wrench.and.screwdriver")
                            }
                        }
                    }
                    if !popular.isEmpty {
                        Section("Trending") {
                            ForEach(popular) { show in
                                NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                                    popularRow(show)
                                }
                            }
                        }
                    }
                    Section("Members") {
                        if members.isEmpty && loadFailed {
                            Text("Couldn't load the club — pull down to try again.")
                                .foregroundStyle(.secondary)
                        }
                        let visible = showAllMembers ? members : Array(members.prefix(memberPreviewCount))
                        ForEach(visible) { m in
                            NavigationLink(value: Route.member(m)) {
                                memberRow(m)
                            }
                        }
                        if members.count > memberPreviewCount {
                            Button {
                                withAnimation { showAllMembers.toggle() }
                            } label: {
                                Label(showAllMembers ? "Show fewer" : "Show all \(members.count) members",
                                      systemImage: showAllMembers ? "chevron.up" : "chevron.down")
                                    .font(.callout)
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
                case .detail(let id, let title, let network, let rating):
                    ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
                case .pick(let title, let network, let rating, let posterUrl, let networkUrl):
                    ShowDetailView(id: nil, initialTitle: title, initialNetwork: network,
                                   initialRating: rating, initialPoster: posterUrl, initialNetworkUrl: networkUrl)
                case .whatsNew:
                    WhatsNewView()
                }
            }
            .sheet(isPresented: $showingDeleteAccount) {
                DeleteAccountView().environmentObject(auth)
            }
            .sheet(isPresented: $showingExport) {
                ExportListsView().environmentObject(auth)
            }
            .sheet(isPresented: $showingLogin) {
                LoginView().environmentObject(auth)
            }
            .sheet(isPresented: $showingSearch) {
                SearchView().environmentObject(auth)
            }
            .sheet(item: $shakePick) { pick in
                ShakePickView(show: pick).environmentObject(auth)
            }
            .onShake { Task { await handleShake() } }
            // Auth may resolve after the member list loads (they refresh
            // concurrently at launch), so react to whichever lands last.
            .onChange(of: auth.memberSlug) { _, _ in maybeAutoOpen() }
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
    // /whats-new opens the changelog, anything else stays on Home. On a cold
    // launch the roster may not be loaded yet — park member URLs and replay
    // them when load() lands (show links need no roster at all).
    @MainActor
    private func route(url: URL) {
        guard let first = url.path.split(separator: "/").first.map({ String($0).lowercased() }) else { return }
        didAutoOpen = true // the tapped link outranks the open-my-own-list nicety
        if let show = Route.showLink(url) { path = [show]; return }
        if first == "whats-new" { path = [.whatsNew]; return }
        let slug = first == "dorothy" ? "whitt" : first // mirror the web's 301
        if let m = members.first(where: { $0.slug == slug }) {
            path = [.member(m)]
        } else if members.isEmpty {
            pendingLink = url
        }
    }

    // On first launch, drop a logged-in member straight onto their own list.
    // Needs both the member list and the session resolved, and only fires once
    // (and only when the stack is still at Home) so it never traps the user.
    @MainActor
    private func maybeAutoOpen() {
        guard !didAutoOpen, path.isEmpty,
              let slug = auth.memberSlug,
              let me = members.first(where: { $0.slug == slug }) else { return }
        didAutoOpen = true
        path = [.member(me)]
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

    // Leads the discovery group beneath My Shows, rather than living in the
    // account menu.
    private var whatsNewRow: some View {
        NavigationLink(value: Route.whatsNew) {
            Label("What's New", systemImage: "sparkles")
        }
    }

    // Account control shown on the title line: a menu (Log out) when signed in,
    // otherwise a tap target that opens the login sheet.
    private var accountControl: some View {
        Group {
            if auth.isLoggedIn {
                Menu {
                    Button {
                        showingExport = true
                    } label: {
                        Label("Export My Lists…", systemImage: "square.and.arrow.up")
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
                    Image(systemName: "person.crop.circle").font(.title)
                }
            } else {
                Button {
                    showingLogin = true
                } label: {
                    Image(systemName: "person.crop.circle").font(.title)
                }
            }
        }
    }

    private func popularRow(_ s: PopularShow) -> some View {
        HStack(spacing: 12) {
            PosterThumb(url: s.posterUrl)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title).font(.body)
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

    private func memberRow(_ m: Member) -> some View {
        HStack {
            Text(m.label)
            Spacer()
            if m.activeCount > 0 {
                Text("\(m.activeCount) active").font(.caption).foregroundStyle(.secondary)
            }
        }
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
        popular = pr ?? popular
        if let link = pendingLink {
            pendingLink = nil
            route(url: link)
        } else {
            maybeAutoOpen()
        }
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
    case detail(id: Int, title: String, network: String?, rating: String?)
    // A recommendation ("Picks for you") has no backing show row yet — open the
    // detail from its title so the user chooses a list, rather than adding it
    // silently.
    case pick(title: String, network: String?, rating: String?, posterUrl: String?, networkUrl: String?)
    case whatsNew
}
