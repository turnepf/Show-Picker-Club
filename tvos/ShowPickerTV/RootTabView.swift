import SwiftUI

// Standard tvOS top tab-bar navigation. Browsing is open; "My Shows" appears
// once you're signed in, and signing in jumps you straight to it. Account is
// where you log in / out.
struct RootTabView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var selection = Tab.home

    enum Tab: Hashable { case mine, home, search, account }

    var body: some View {
        TabView(selection: $selection) {
            if auth.isLoggedIn {
                MyShowsView()
                    .tabItem { Label("My Shows", systemImage: "play.tv") }
                    .tag(Tab.mine)
            }
            HomeView()
                .tabItem { Label("Home", systemImage: "house") }
                .tag(Tab.home)
            SearchView()
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
    @State private var me: Member?
    @State private var loading = true

    var body: some View {
        NavigationStack {
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
