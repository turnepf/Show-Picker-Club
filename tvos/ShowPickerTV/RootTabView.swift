import SwiftUI

// Standard tvOS top tab-bar navigation. Browsing is open; "My Shows" appears
// once you're signed in, and signing in jumps you straight to it. Account is
// where you log in / out.
struct RootTabView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var selection = Tab.home
    // Each tab owns its navigation stack here so selecting a tab can reset it
    // to the section root. tvOS's Menu button jumps focus to the tab bar
    // instead of popping the stack, so without this a show detail you opened
    // stays pushed and there's no way back to the section's full list.
    @State private var minePath = NavigationPath()
    @State private var homePath = NavigationPath()
    @State private var searchPath = NavigationPath()

    enum Tab: Hashable { case mine, home, search, account }

    // Selecting any tab (whether switching to it or re-tapping the current one)
    // pops any show detail open in it, so you always land on the section's
    // full grid of cards.
    private var tabSelection: Binding<Tab> {
        Binding(
            get: { selection },
            set: { newValue in
                switch newValue {
                case .mine: minePath = NavigationPath()
                case .home: homePath = NavigationPath()
                case .search: searchPath = NavigationPath()
                case .account: break
                }
                selection = newValue
            }
        )
    }

    var body: some View {
        TabView(selection: tabSelection) {
            if auth.isLoggedIn {
                MyShowsView(path: $minePath)
                    .tabItem { Label("My Shows", systemImage: "play.tv") }
                    .tag(Tab.mine)
            }
            HomeView(path: $homePath)
                .tabItem { Label("Home", systemImage: "house") }
                .tag(Tab.home)
            SearchView(path: $searchPath)
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(Tab.search)
            AccountView()
                .tabItem { Label(auth.isLoggedIn ? "Account" : "Sign In", systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        .task { await auth.refresh() }
        // Land on My Shows right after signing in; fall back to Home on logout.
        .onChange(of: auth.memberSlug) { _, slug in
            selection = slug != nil ? .mine : .home
        }
    }
}

// The signed-in member's own lists, resolved from the member list.
struct MyShowsView: View {
    @EnvironmentObject private var auth: AuthStore
    @Binding var path: NavigationPath
    @State private var me: Member?
    @State private var loading = true

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let me {
                    MemberView(member: me)
                } else if loading {
                    ZStack { Theme.background.ignoresSafeArea(); ProgressView() }
                } else {
                    ZStack {
                        Theme.background.ignoresSafeArea()
                        Text("Couldn't load your shows.")
                            .font(.system(size: 28))
                            .foregroundColor(Theme.muted)
                    }
                }
            }
            .showDestinations()
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        guard let slug = auth.memberSlug else { return }
        let members = (try? await API.members()) ?? []
        me = members.first { $0.slug == slug }
    }
}
