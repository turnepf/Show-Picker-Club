import SwiftUI
import UIKit

// Standard tvOS top tab-bar navigation. Trending is open; member show lists
// are members-only (the server 401s them without a session). "My Shows"
// appears once you're signed in. Account is where you log in / out.
//
// Home leads the bar and is the launch screen — the standard on every
// platform (see docs/PRODUCT.md#navigation-standard). Signing in still lands
// you on your lists, but a session restored at launch does not.
struct RootTabView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var selection = Tab.home
    // Each tab owns its navigation stack here so tab selection (and clicking
    // a tab-bar item — see below) can reset it to the section root.
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
    // TabBarClickCatcher below.
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
            HomeView(path: $homePath)
                .tabItem { Label("Home", systemImage: "house") }
                .tag(Tab.home)
            if auth.isLoggedIn {
                MyShowsView(path: $minePath)
                    .tabItem { Label("My Shows", systemImage: "play.tv") }
                    .tag(Tab.mine)
            }
            SearchView(path: $searchPath)
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(Tab.search)
            AccountView()
                .tabItem { Label(auth.isLoggedIn ? "Account" : "Sign In", systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        .task { await auth.refresh() }
        // Pop every tab to its section root when a tab-bar item is CLICKED.
        // tvOS tab bars select on focus, so clicking the already-selected tab
        // from a pushed show card produces no selection change at all — the
        // selection binding never fires and the card stays put. And popping
        // merely when the bar takes focus is too eager (bringing up the bar
        // to glance at it would lose your place). A select-press recognizer
        // installed on the underlying UITabBar catches the actual click.
        .background(TabBarClickCatcher {
            // Focusing a *different* tab already switched sections and reset
            // its path via the selection binding, so by click time the
            // clicked tab is always the selected one: just pop the stacks.
            if !minePath.isEmpty { minePath = NavigationPath() }
            if !homePath.isEmpty { homePath = NavigationPath() }
            if !searchPath.isEmpty { searchPath = NavigationPath() }
        })
        // Land on My Shows right after signing in; fall back to Home on logout.
        .onChange(of: auth.memberSlug) { _, slug in
            // Signing in INSERTS the My Shows tab and signing out REMOVES it.
            // Selecting a tab in the same update as that structural change
            // can leave the target tab rendering empty on tvOS — let the
            // TabView commit the change first, then switch.
            if slug != nil {
                // Only an actual sign-in follows through to My Shows: you're
                // on the Account tab because you just used it. The same
                // notification fires when a stored session resolves at
                // launch, and that must leave you on Home.
                guard selection == .account else { return }
                Task { @MainActor in selection = .mine }
            } else if selection == .mine {
                // The tab we're sitting on is about to disappear.
                Task { @MainActor in selection = .home }
            }
        }
    }

}

// Invisible helper that finds the window's UITabBar (SwiftUI's tvOS TabView
// is backed by UITabBarController) and attaches a Siri-remote select-press
// recognizer to it. The recognizer only sees presses while focus is inside
// the bar — content presses never reach it — so firing means "the user
// clicked a tab item", which SwiftUI otherwise surfaces no event for when
// the clicked tab is already selected.
private struct TabBarClickCatcher: UIViewRepresentable {
    let onClick: () -> Void

    func makeUIView(context: Context) -> CatcherView { CatcherView() }

    func updateUIView(_ uiView: CatcherView, context: Context) {
        uiView.onClick = onClick
    }

    final class CatcherView: UIView {
        var onClick: (() -> Void)?
        private weak var installedOn: UITabBar?
        private var attemptsLeft = 20

        override func didMoveToWindow() {
            super.didMoveToWindow()
            installIfNeeded()
        }

        private func installIfNeeded() {
            guard installedOn == nil else { return }
            guard let window else { return }
            if let bar = Self.findTabBar(in: window) {
                let press = UITapGestureRecognizer(target: self, action: #selector(barClicked))
                press.allowedPressTypes = [NSNumber(value: UIPress.PressType.select.rawValue)]
                press.cancelsTouchesInView = false
                bar.addGestureRecognizer(press)
                installedOn = bar
            } else if attemptsLeft > 0 {
                // The tab bar may not be in the window yet on first layout;
                // retry briefly rather than assuming it never appears.
                attemptsLeft -= 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                    self?.installIfNeeded()
                }
            }
        }

        @objc private func barClicked() { onClick?() }

        private static func findTabBar(in view: UIView) -> UITabBar? {
            if let bar = view as? UITabBar { return bar }
            for sub in view.subviews {
                if let bar = findTabBar(in: sub) { return bar }
            }
            return nil
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
