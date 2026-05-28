import SwiftUI

struct HomeView: View {
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
                        .foregroundColor(Theme.ink)
                        .padding(.top, 20)

                    if loading {
                        ProgressView().padding(.top, 80)
                    } else if let errorText {
                        Text(errorText).foregroundColor(.secondary)
                    } else {
                        if !popular.isEmpty {
                            sectionHeader("What Members Are Watching")
                            ScrollView(.horizontal, showsIndicators: false) {
                                LazyHStack(alignment: .top, spacing: 40) {
                                    ForEach(popular) { show in
                                        NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                                            ShowCard(title: show.title,
                                                     network: show.network,
                                                     rating: show.rating)
                                        }
                                        .buttonStyle(.card)
                                    }
                                }
                                .padding(.horizontal, 4)
                            }
                        }

                        sectionHeader("Members")
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 30), count: 4),
                                  spacing: 30) {
                            ForEach(members) { member in
                                NavigationLink(value: Route.member(member)) {
                                    MemberTile(member: member)
                                }
                                .buttonStyle(.card)
                            }
                        }
                    }
                }
                .padding(.horizontal, 60)
                .padding(.bottom, 60)
            }
            .background(Theme.cream.ignoresSafeArea())
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .member(let m):
                    MemberView(member: m)
                case .detail(let id, let title, let network, let rating):
                    ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
                }
            }
            .task { await load() }
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 32, weight: .semibold))
            .foregroundColor(Theme.ink)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            async let m = API.members()
            async let p = API.popular()
            // Show members sorted by recent activity, most active first.
            members = try await m.sorted {
                ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "")
            }
            popular = try await p
        } catch {
            errorText = "Couldn't load. Check the connection and try again."
        }
    }
}

struct MemberTile: View {
    let member: Member
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14)
                .fill(Theme.tileColor(for: member.slug))
            VStack(spacing: 6) {
                Text(member.label)
                    .font(.system(size: 30, weight: .bold))
                    .foregroundColor(.white)
                if let c = member.watchingCount {
                    Text("\(c) watching")
                        .font(.system(size: 18))
                        .foregroundColor(.white.opacity(0.85))
                }
            }
            .padding(12)
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
