import SwiftUI
import ShowPickerCore

// The "Home" tab: Trending, plus your groups as the way into other members'
// lists. It used to list the whole club roster; groups replaced that on
// purpose — a group is people you chose, and the roster wasn't something
// most members could put names to. Auth and your own lists live in their
// own tabs.
struct HomeView: View {
    @Binding var path: NavigationPath
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var groups: [ClubGroup] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 50) {
                    Text("Show Picker Club")
                        .font(.system(size: 56, weight: .bold))
                        .foregroundColor(Theme.text)
                        .padding(.top, 20)

                    if loading {
                        ProgressView()
                            .padding(.top, 80)
                            .frame(maxWidth: .infinity)
                    } else if let errorText {
                        VStack(spacing: 24) {
                            Text(errorText)
                                .font(.system(size: 28))
                                .foregroundColor(Theme.muted)
                            Button("Try again") { Task { await load() } }
                                .font(.system(size: 24, weight: .semibold))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 40)
                    } else {
                        popularShelf
                        // Groups are for logged-in members only
                        if auth.isLoggedIn {
                            groupsSection
                        } else {
                            signedOutPitch
                        }

                        // Attribution required by the TMDB API terms; OMDb
                        // credited alongside since IMDb ratings come through it.
                        Text("Ratings and metadata from IMDb (via OMDb) and TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.")
                            .font(.system(size: 18))
                            .foregroundColor(Theme.muted)
                            .frame(maxWidth: .infinity, alignment: .center)
                    }
                }
                .padding(.horizontal, 60)
                .padding(.bottom, 60)
            }
            .background(Theme.background.ignoresSafeArea())
            .showDestinations()
        }
        // Re-runs on every visit to the tab: keep retrying until content
        // lands, so one failed launch-time load (cold Wi-Fi, network blip)
        // doesn't brick Home for the whole session.
        .task { if members.isEmpty { await load() } }
    }

    @ViewBuilder private var popularShelf: some View {
        if !popular.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeader("Trending")
                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(alignment: .top, spacing: 40) {
                        ForEach(popular) { show in
                            NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                                ShowCard(title: show.title,
                                         networkLogoUrl: show.networkLogoUrl,
                                         posterUrl: show.posterUrl)
                            }
                            .buttonStyle(PushButtonStyle())
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 30)
                }
            }
        }
    }

    // Your groups, as the way into other people's lists — the club roster used
    // to sit here, and most members don't know half of it. A group you're in
    // is a set of people you actually chose.
    private var groupsSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionHeader("Groups")
            if groups.isEmpty {
                NavigationLink(value: Route.groupsList) {
                    Text("Browse your groups")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundColor(Theme.text)
                        .padding(30)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surface)
                        .cornerRadius(16)
                }
                .buttonStyle(PushButtonStyle())
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 24), count: 4),
                          spacing: 24) {
                    ForEach(groups) { group in
                        NavigationLink(value: Route.groupDetail(group.id)) {
                            GroupTileTV(group: group)
                        }
                        .buttonStyle(PushButtonStyle())
                    }
                }
            }
        }
    }

    // Logged out, Trending above is all there is — say what the app is for and
    // where to sign in. The Apple TV has no keyboard worth typing on, so this
    // points at the Account tab rather than pretending sign-in happens here.
    private var signedOutPitch: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("Keep track of what you're watching")
            Text("Four lists — Watching, Awaiting, Loved and Next Up — with premiere dates, ratings and where to watch. Make a group on your iPhone or iPad to see what your people are watching.")
                .font(.system(size: 22))
                .foregroundColor(Theme.muted)
                .frame(maxWidth: 1100, alignment: .leading)
            Text("Sign in from the Account tab to see your lists and your groups.")
                .font(.system(size: 22, weight: .semibold))
                .foregroundColor(Theme.text)
        }
        .padding(30)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .cornerRadius(16)
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 32, weight: .semibold))
            .foregroundColor(Theme.text)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let m = API.members()
            async let p = API.popular()
            // Most recently active first, then most active (Watching + Next
            // Up + Loved) as the tiebreaker — the same roster order as
            // iPhone, iPad, and web.
            members = try await m.sorted {
                let la = $0.lastActivityAt ?? "", lb = $1.lastActivityAt ?? ""
                if la != lb { return la > lb }
                return $0.activeCount > $1.activeCount
            }
            popular = try await p
            // Session-gated and non-fatal: logged out (or no groups) just
            // means the section falls back to its browse link.
            groups = (try? await API.groups().groups) ?? []
        } catch {
            errorText = "Couldn't load. Check the connection and try again."
        }
    }
}

