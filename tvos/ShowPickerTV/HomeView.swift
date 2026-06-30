import SwiftUI

// The "Home" tab: browse what members are watching and the member directory.
// Auth and the member's own lists live in their own tabs.
struct HomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
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
                        Text(errorText)
                            .font(.system(size: 28))
                            .foregroundColor(Theme.muted)
                            .padding(.top, 40)
                    } else {
                        popularShelf
                        membersSection
                    }
                }
                .padding(.horizontal, 60)
                .padding(.bottom, 60)
            }
            .background(Theme.background.ignoresSafeArea())
            .showDestinations()
        }
        .task { if loading { await load() } }
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

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let m = API.members()
            async let p = API.popular()
            members = try await m.sorted {
                if $0.activeCount != $1.activeCount { return $0.activeCount > $1.activeCount }
                return ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "")
            }
            popular = try await p
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
