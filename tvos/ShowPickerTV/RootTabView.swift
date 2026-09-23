import SwiftUI
import UIKit

// Standard tvOS top tab-bar navigation. Trending is open; member show lists
// are members-only (the server 401s them without a session). "My Shows" and
// "Groups" appear once you're signed in. Account is where you log in / out.
//
// Home leads the bar and is the launch screen — the standard on every
// platform (see docs/PRODUCT.md#navigation-standard). Signing in still lands
// you on your lists, but a session restored at launch does not.
struct RootTabView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection = Tab.home
    // Each tab owns its navigation stack here so tab selection (and clicking
    // a tab-bar item — see below) can reset it to the section root.
    // Without this, a show detail you opened stays pushed when you jump to
    // the tab bar, and there's no way back to the section's full list.
    @State private var minePath = NavigationPath()
    @State private var homePath = NavigationPath()
    @State private var groupsPath = NavigationPath()
    @State private var searchPath = NavigationPath()

    enum Tab: Hashable { case mine, home, groups, search, account }

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
                case .groups: groupsPath = NavigationPath()
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
                // Second nav item after My Shows, same as iPhone and iPad.
                // Home keeps its Groups shelf — that's the browse surface;
                // this is the way in when you know where you're going.
                GroupsTabView(path: $groupsPath)
                    .tabItem { Label("Groups", systemImage: "person.2.fill") }
                    .tag(Tab.groups)
            }
            SearchView(path: $searchPath)
                .tabItem { Label("Search", systemImage: "magnifyingglass") }
                .tag(Tab.search)
            AccountView()
                .tabItem { Label(auth.isLoggedIn ? "Account" : "Sign In", systemImage: "person.crop.circle") }
                .tag(Tab.account)
        }
        .task { await auth.refresh() }
        // Waking the Apple TV back into the app is using it too: the check
        // stamps the session's last_seen_at, which the member roster sorts on.
        // The answer is discarded so an offline wake can't read as a sign-out.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { _ = await API.checkAuth() } }
        }
        // Pop every tab to its section root when a tab-bar item is CLICKED.
        // tvOS tab bars select on focus, so clicking the already-selected tab
        // from a pushed show card produces no selection change at all — the
        // selection binding never fires and the card stays put. And popping
        // merely when the bar takes focus is too eager (bringing up the bar
        // to glance at it would lose your place). A window-level select-press
        // listener catches the actual click and asks the focus system whether
        // the bar was what got clicked — see TabBarClickCatcher.
        .background(TabBarClickCatcher {
            // Only the section actually on screen: a tab the user is leaving
            // gets reset by the selection binding on the way back into it, and
            // popping it here churns other stacks mid-transition.
            //
            // Unanimated on purpose. The click has already moved focus into
            // the detail by the time this runs, so an animated pop reads as a
            // late slide — a clean cut is what "the tab took me back" should
            // look like.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                switch selection {
                case .mine: if !minePath.isEmpty { minePath = NavigationPath() }
                case .home: if !homePath.isEmpty { homePath = NavigationPath() }
                case .groups: if !groupsPath.isEmpty { groupsPath = NavigationPath() }
                case .search: if !searchPath.isEmpty { searchPath = NavigationPath() }
                case .account: break
                }
            }
        })
        // Land on My Shows right after signing in; fall back to Home on logout.
        .onChange(of: auth.memberSlug) { _, slug in
            // Signing in INSERTS the My Shows and Groups tabs, and signing
            // out REMOVES them.
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
            } else if selection == .mine || selection == .groups {
                // The tab we're sitting on is about to disappear.
                Task { @MainActor in selection = .home }
            }
        }
    }

}

// Invisible helper that reports a click on a tab-bar item — including a click
// on the tab that is ALREADY selected, which is the case SwiftUI surfaces no
// event for at all.
//
// Two earlier attempts failed on the device, both for the same reason: they
// guessed at where the tab bar sits. Attaching a select-press recognizer to
// the UITabBar itself never fired, and walking UP the view-controller chain
// for a UITabBarController never found one — from a `.background()`
// representable the chain is only ever the root UIHostingController, because
// the TabView's tab bar controller is a DESCENDANT of that host, not an
// ancestor.
//
// What is actually true on tvOS, confirmed by logging the live hierarchy: a
// select-press recognizer on the WINDOW does see every remote click, and at
// the moment of a tab click the focus system's focused item is a
// UITabBarButton inside a UITabBar. A click on content focuses something else
// entirely (a SwiftUI focus item, not a UIView in the bar), so the focused
// item is what separates the two cases. Hook the window, then ask focus.
private struct TabBarClickCatcher: UIViewControllerRepresentable {
    let onClick: () -> Void

    func makeUIViewController(context: Context) -> Controller {
        Controller(onClick: onClick)
    }

    func updateUIViewController(_ uiViewController: Controller, context: Context) {
        uiViewController.onClick = onClick
    }

    final class Controller: UIViewController, UIGestureRecognizerDelegate {
        var onClick: () -> Void
        private var installed = false
        private var attemptsLeft = 20
        private var focusWasInTabBar = false
        private var focusLeftBarAt: Date?

        // How long after the bar loses focus a select press still counts as
        // that bar click. Measured on an Apple TV 4K: a real tab click lands
        // 0.10–0.19s behind the focus move, while the soonest press that was
        // a content click rather than a tab click came 0.66s behind it. This
        // sits between the two, near the fast end — the cost of missing a
        // click is a click that does nothing, the cost of catching a stray one
        // is throwing away the screen someone was reading.
        private static let clickWindow: TimeInterval = 0.3

        init(onClick: @escaping () -> Void) {
            self.onClick = onClick
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) {
            fatalError("init(coder:) has not been implemented")
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            installIfNeeded()
        }

        private func installIfNeeded() {
            guard !installed else { return }
            guard let window = view.window else {
                // The background view may not be in the window on the first
                // pass; retry briefly rather than giving up on the first miss.
                if attemptsLeft > 0 {
                    attemptsLeft -= 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
                        self?.installIfNeeded()
                    }
                }
                return
            }
            installed = true
            let press = UITapGestureRecognizer(target: self, action: #selector(selectPressed))
            press.allowedPressTypes = [NSNumber(value: UIPress.PressType.select.rawValue)]
            // Observe the press; never swallow it. The bar still does its own
            // job with the same click.
            press.cancelsTouchesInView = false
            press.delegate = self
            window.addGestureRecognizer(press)
            focusWasInTabBar = focusIsInTabBar
            NotificationCenter.default.addObserver(
                self, selector: #selector(focusChanged),
                name: UIFocusSystem.didUpdateNotification, object: nil)
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        // Clicking a tab item moves focus out of the bar and into the content
        // BEFORE the press recognizer runs, so asking "is the bar focused?"
        // at press time answers no. Look back instead: the bar losing focus a
        // few milliseconds earlier is what a click looks like from here. A
        // user who merely swipes down out of the bar produces the same focus
        // move with no press behind it, and so is left alone.
        @objc private func selectPressed() {
            let sinceLeft = focusLeftBarAt.map { Date().timeIntervalSince($0) }
            let inBar = focusIsInTabBar
            guard inBar || (sinceLeft ?? .greatestFiniteMagnitude) < Self.clickWindow else { return }
            onClick()
        }

        @objc private func focusChanged() {
            let nowInBar = focusIsInTabBar
            if focusWasInTabBar && !nowInBar {
                focusLeftBarAt = Date()
            }
            focusWasInTabBar = nowInBar
        }

        // The click means "a tab item" only when the focus system says the
        // focused item is a view inside the bar. Content items are SwiftUI
        // focus items rather than UIViews, so they fall out here.
        private var focusIsInTabBar: Bool {
            guard let window = view.window,
                  let system = UIFocusSystem.focusSystem(for: window),
                  let focused = system.focusedItem as? UIView else { return false }
            var current: UIView? = focused
            while let view = current {
                if view is UITabBar { return true }
                current = view.superview
            }
            return false
        }
    }
}

// Groups as a tab root. GroupsListViewTV owns no stack of its own — it's also
// pushed from Home's Groups shelf — so the tab supplies one.
struct GroupsTabView: View {
    @Binding var path: NavigationPath

    var body: some View {
        NavigationStack(path: $path) {
            GroupsListViewTV()
                .showDestinations()
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

