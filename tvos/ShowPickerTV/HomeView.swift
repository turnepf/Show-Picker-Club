import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true
    @State private var errorText: String?
    @State private var path: [Route] = []
    @State private var showingLogin = false
    // Auto-open the logged-in member's own list once per launch, mirroring
    // iOS. Tracked so backing out to Home doesn't bounce them forward again.
    @State private var didAutoOpen = false

    // The logged-in member, resolved against the loaded member list.
    private var myMember: Member? {
        guard let slug = auth.memberSlug else { return nil }
        return members.first { $0.slug == slug }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 50) {
                    header

                    if loading {
                        ProgressView()
                            .padding(.top, 80)
                            .frame(maxWidth: .infinity)
                    } else if let errorText {
                        Text(errorText)
                            .font(.system(size: 28))
                            .foregroundColor(Theme.muted)
                            .padding(.top, 40)
                    } else {
                        accountCard
                        popularShelf
                        membersSection
                    }
                }
                .padding(.horizontal, 60)
                .padding(.bottom, 60)
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .member(let m):
                    MemberView(member: m)
                case .detail(let id, let title, let network, let rating):
                    ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
                }
            }
            .task { if loading { await load() } }
            .fullScreenCover(isPresented: $showingLogin) {
                LoginView().environmentObject(auth)
            }
            // Auth may resolve after the member list loads (they refresh
            // concurrently at launch), and again on a fresh login. React to
            // whichever lands: close the login screen and open the member's list.
            .onChange(of: auth.memberSlug) { _, _ in
                showingLogin = false
                maybeAutoOpen()
            }
        }
    }

    // MARK: Sections

    private var header: some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Show Picker Club")
                .font(.system(size: 56, weight: .bold))
                .foregroundColor(Theme.text)
            Spacer()
            if let me = myMember {
                HStack(spacing: 24) {
                    Text("Hi, \(me.label)")
                        .font(.system(size: 24, weight: .medium))
                        .foregroundColor(Theme.muted)
                    Button("Log out") { Task { await auth.logout() } }
                        .font(.system(size: 22, weight: .semibold))
                }
            } else {
                Button { showingLogin = true } label: {
                    Label("Log in", systemImage: "person.crop.circle")
                        .font(.system(size: 22, weight: .semibold))
                }
            }
        }
        .padding(.top, 20)
    }

    // Prominent jump to your own lists when signed in; an invitation to sign
    // in otherwise. Browsing below works either way.
    @ViewBuilder private var accountCard: some View {
        if let me = myMember {
            Button { path = [.member(me)] } label: {
                bannerCard(title: "My Shows",
                           subtitle: "Open \(me.label)'s lists",
                           systemImage: "person.crop.circle.fill",
                           tint: Theme.listColor("watching"))
            }
            .buttonStyle(PushButtonStyle())
        } else if !auth.isLoggedIn {
            Button { showingLogin = true } label: {
                bannerCard(title: "Log in to see your shows",
                           subtitle: "Browse the club below, or sign in to open your own lists",
                           systemImage: "person.crop.circle.badge.plus",
                           tint: Theme.listColor("waiting"))
            }
            .buttonStyle(PushButtonStyle())
        }
    }

    @ViewBuilder private var popularShelf: some View {
        if !popular.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeader("What Members Are Watching")
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 40) {
                        ForEach(popular) { show in
                            NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                                ShowCard(title: show.title,
                                         network: show.network,
                                         rating: show.rating)
                            }
                            .buttonStyle(PushButtonStyle())
                        }
                    }
                    .padding(.horizontal, 4)
                }
            }
        }
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionHeader("Members")
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 30), count: 4),
                      spacing: 30) {
                ForEach(members) { member in
                    NavigationLink(value: Route.member(member)) {
                        MemberTile(member: member, isMe: member.slug == auth.memberSlug)
                    }
                    .buttonStyle(PushButtonStyle())
                }
            }
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 32, weight: .semibold))
            .foregroundColor(Theme.text)
    }

    private func bannerCard(title: String, subtitle: String, systemImage: String, tint: Color) -> some View {
        HStack(spacing: 24) {
            Image(systemName: systemImage)
                .font(.system(size: 44))
                .foregroundColor(.white)
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(.white)
                Text(subtitle)
                    .font(.system(size: 22))
                    .foregroundColor(.white.opacity(0.85))
            }
            Spacer()
        }
        .padding(28)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            LinearGradient(colors: [tint, tint.opacity(0.8)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
    }

    // MARK: Behavior

    // Drop a logged-in member straight onto their own list. Needs both the
    // member list and the session resolved, fires once, and only when the
    // stack is still at Home so it never traps the user.
    @MainActor
    private func maybeAutoOpen() {
        guard !didAutoOpen, path.isEmpty, let me = myMember else { return }
        didAutoOpen = true
        path = [.member(me)]
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let m = API.members()
            async let p = API.popular()
            // Most active first, then most recent activity as a tiebreaker.
            members = try await m.sorted {
                if $0.activeCount != $1.activeCount { return $0.activeCount > $1.activeCount }
                return ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "")
            }
            popular = try await p
            maybeAutoOpen()
        } catch {
            errorText = "Couldn't load. Check the connection and try again."
        }
    }
}

struct MemberTile: View {
    let member: Member
    var isMe: Bool = false

    var body: some View {
        ZStack(alignment: .topTrailing) {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(
                    LinearGradient(colors: [Theme.tileColor(for: member.slug),
                                            Theme.tileColor(for: member.slug).opacity(0.78)],
                                   startPoint: .topLeading, endPoint: .bottomTrailing)
                )
                .overlay(
                    VStack(spacing: 6) {
                        Text(member.label)
                            .font(.system(size: 30, weight: .bold))
                            .foregroundColor(.white)
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                        if let c = member.watchingCount, c > 0 {
                            Text("\(c) watching")
                                .font(.system(size: 18))
                                .foregroundColor(.white.opacity(0.85))
                        }
                    }
                    .padding(12)
                )

            if isMe {
                Image(systemName: "star.fill")
                    .font(.system(size: 22))
                    .foregroundColor(.white)
                    .padding(12)
            }
        }
        .frame(height: 170)
    }
}

// Navigation routes. Hashable so they work with NavigationStack value links.
// Detail carries minimal info for an instant header; the full record + cast
// are fetched by id on the detail screen.
enum Route: Hashable {
    case member(Member)
    case detail(id: Int, title: String, network: String?, rating: String?)
}
