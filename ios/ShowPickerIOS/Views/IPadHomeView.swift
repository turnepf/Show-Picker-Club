import SwiftUI

// Purpose-built iPad layout: a persistent sidebar (your shows, Trending, and
// every member) beside a detail column that reuses the same MemberView and
// ShowDetailView screens the iPhone uses. Selecting a member fills the detail
// column with their lists; tapping a show pushes its detail within that column.
//
// iPhone keeps the single-stack HomeView untouched — RootView switches by
// device idiom.

// What the sidebar can point at. `myShows` is kept distinct from the member
// rows so your own entry (which also appears in the Members list) doesn't share
// a selection tag with it.
enum SidebarItem: Hashable {
    case myShows
    case trending
    case admin
    case member(Member)
}

struct IPadHomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true
    @State private var selection: SidebarItem?
    @State private var showingLogin = false
    @State private var showingSearch = false
    @State private var showingWhatsNew = false

    private var myMember: Member? {
        guard let slug = auth.memberSlug else { return nil }
        return members.first { $0.slug == slug }
    }

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationTitle("Show Picker Club")
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
            // (to show detail, Vibe, etc.) push here. `.id(selection)` resets it
            // to the section root whenever the sidebar choice changes.
            NavigationStack {
                detailRoot
                    .navigationDestination(for: Route.self) { route in
                        destination(route)
                    }
            }
            .id(selection)
        }
        .task { if loading { await load() } }
        .sheet(isPresented: $showingLogin) { LoginView().environmentObject(auth) }
        .sheet(isPresented: $showingSearch) { SearchView().environmentObject(auth) }
        .sheet(isPresented: $showingWhatsNew) { WhatsNewView() }
        // Auth may resolve after the member list loads; land on My Shows once it
        // does (unless the user has already picked something).
        .onChange(of: auth.memberSlug) { _, _ in applyInitialSelection() }
    }

    // MARK: Sidebar

    private var sidebar: some View {
        List(selection: $selection) {
            if myMember != nil {
                Section {
                    Label("My Shows", systemImage: "person.crop.circle")
                        .tag(SidebarItem.myShows)
                }
            } else if !auth.isLoggedIn {
                Section {
                    Button { showingLogin = true } label: {
                        Label("Log in to see your shows", systemImage: "person.crop.circle.badge.plus")
                    }
                }
            }
            if auth.isAdmin {
                Section {
                    Label("Admin", systemImage: "wrench.and.screwdriver")
                        .tag(SidebarItem.admin)
                }
            }
            if !popular.isEmpty {
                Section {
                    Label("Trending", systemImage: "flame")
                        .tag(SidebarItem.trending)
                }
            }
            Section("Members") {
                ForEach(members) { m in
                    memberRow(m).tag(SidebarItem.member(m))
                }
            }
            // Attribution required by the TMDB API terms; OMDb credited too.
            Section {
                Text("Ratings and metadata from IMDb (via OMDb) and TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .overlay { if loading && members.isEmpty { ProgressView() } }
        .refreshable { await load() }
    }

    private func memberRow(_ m: Member) -> some View {
        HStack {
            Text(m.label)
            Spacer()
            if m.activeCount > 0 {
                Text("\(m.activeCount)").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private var accountControl: some View {
        Group {
            if auth.isLoggedIn {
                Menu {
                    Button { showingWhatsNew = true } label: {
                        Label("What's New", systemImage: "sparkles")
                    }
                    Button(role: .destructive) {
                        Task { await auth.logout() }
                    } label: {
                        Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
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
            case .myShows:
                if let me = myMember {
                    MemberView(member: me)
                } else {
                    placeholder("Log in on this iPad to see your shows.", "person.crop.circle")
                }
            case .member(let m):
                MemberView(member: m)
            case .trending:
                TrendingListView(shows: popular)
            case .admin:
                AdminView().environmentObject(auth)
            }
        } else {
            placeholder("Pick a member or Trending from the sidebar.", "sidebar.left")
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
        guard selection == nil else { return }
        if myMember != nil {
            selection = .myShows
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
        // Most active first, then most recent activity — same as HomeView.
        members = mr.sorted {
            if $0.activeCount != $1.activeCount { return $0.activeCount > $1.activeCount }
            return ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "")
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
