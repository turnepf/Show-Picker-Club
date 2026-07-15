import SwiftUI
import UIKit
import Combine

// Standard tvOS top tab-bar navigation. The roster and Trending are open;
// member show lists are members-only (the server 401s them without a
// session). "My Shows" appears once you're signed in, and signing in jumps
// you straight to it. Account is where you log in / out.
struct RootTabView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var selection = Tab.home
    // Each tab owns its navigation stack here so tab selection (and the
    // tab bar gaining focus — see below) can reset it to the section root.
    // Without this, a show detail you opened stays pushed when you jump to
    // the tab bar, and there's no way back to the section's full list.
    @State private var minePath = NavigationPath()
    @State private var homePath = NavigationPath()
    @State private var searchPath = NavigationPath()

    enum Tab: Hashable { case mine, home, search, account }

    // Switching tabs pops any show detail open in the target tab, so you
    // always land on the section's full grid of cards. Note this only covers
    // *changes*: clicking the tab you're already on never calls the setter
    // (SwiftUI only writes new values), so the same-tab case is handled by
    // the tab-bar focus observer on the TabView below.
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
        // Pop every tab to its section root the moment the tab bar takes
        // focus. tvOS tab bars select on focus, not on click, so clicking the
        // already-selected tab from a pushed show card produces no event at
        // all — the selection binding never fires and the card stays put.
        // Instead, treat "user brought up the tab bar" as the intent to
        // navigate at section level: reset the stacks right away so clicking
        // Home / My Shows (or just swiping back down) lands on the grid.
        .onReceive(NotificationCenter.default.publisher(for: UIFocusSystem.didUpdateNotification)) { note in
            guard let context = note.userInfo?[UIFocusSystem.focusUpdateContextUserInfoKey] as? UIFocusUpdateContext,
                  Self.focusIsInTabBar(context.nextFocusedItem)
            else { return }
            // Only touch non-empty paths: writing a fresh NavigationPath is
            // never equatable-skipped, so gratuitous writes rebuild every
            // tab's stack (and restart all their image loads) on each match.
            if !minePath.isEmpty { minePath = NavigationPath() }
            if !homePath.isEmpty { homePath = NavigationPath() }
            if !searchPath.isEmpty { searchPath = NavigationPath() }
        }
        // Land on My Shows right after signing in; fall back to Home on logout.
        .onChange(of: auth.memberSlug) { _, slug in
            // Signing in INSERTS the My Shows tab and signing out REMOVES it.
            // Selecting a tab in the same update as that structural change
            // can leave the target tab rendering empty on tvOS — let the
            // TabView commit the change first, then switch.
            Task { @MainActor in selection = slug != nil ? .mine : .home }
        }
    }

    // True only when the newly focused item is a view sitting inside a real
    // UITabBar. Deliberately a strict superview walk: the focus-ENVIRONMENT
    // chain must not be used here, because on tvOS it climbs from any
    // focused content view up into the UITabBarController that hosts every
    // tab — so a name match like "TabBar" fires for the whole app, popping
    // a show card the instant focus lands inside it.
    private static func focusIsInTabBar(_ item: (any UIFocusItem)?) -> Bool {
        var view = item as? UIView
        while let current = view {
            if current is UITabBar { return true }
            view = current.superview
        }
        return false
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
                    MemberView(member: me, canAdd: true)
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
