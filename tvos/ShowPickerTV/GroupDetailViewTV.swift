import SwiftUI
import ShowPickerCore

struct GroupDetailViewTV: View {
    let groupId: Int
    @State private var group: Group?
    @State private var members: [GroupMember] = []
    @State private var trending: [PopularShow] = []
    @State private var loading = true
    @State private var errorText: String?
    @State private var selectedTab: Tab = .trending

    enum Tab {
        case trending
        case members
    }

    var body: some View {
        ZStack {
            if loading {
                VStack(spacing: 30) {
                    ProgressView()
                        .scaleEffect(2)
                    Text("Loading…")
                        .font(.system(size: 28))
                        .foregroundColor(Theme.muted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorText = errorText {
                VStack(spacing: 24) {
                    Text(errorText)
                        .font(.system(size: 28))
                        .foregroundColor(Theme.muted)
                    Button("Try again") { Task { await load() } }
                        .font(.system(size: 24, weight: .semibold))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let group = group {
                ScrollView {
                    VStack(alignment: .leading, spacing: 40) {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(group.name)
                                .font(.system(size: 56, weight: .bold))
                                .foregroundColor(Theme.text)
                            Text("\(members.count) member\(members.count == 1 ? "" : "s")")
                                .font(.system(size: 24))
                                .foregroundColor(Theme.muted)
                        }
                        .padding(.top, 20)

                        Picker("Tab", selection: $selectedTab) {
                            Text("Trending").tag(Tab.trending)
                            Text("Members").tag(Tab.members)
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal)
                        .frame(height: 60)

                        if selectedTab == .trending {
                            if trending.isEmpty {
                                Text("No shows yet")
                                    .font(.system(size: 28))
                                    .foregroundColor(Theme.muted)
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .padding(60)
                            } else {
                                LazyVStack(alignment: .leading, spacing: 20) {
                                    ForEach(trending) { show in
                                        trendingRow(show)
                                    }
                                }
                            }
                        } else {
                            if members.isEmpty {
                                Text("No members")
                                    .font(.system(size: 28))
                                    .foregroundColor(Theme.muted)
                                    .frame(maxWidth: .infinity, alignment: .center)
                                    .padding(60)
                            } else {
                                LazyVStack(alignment: .leading, spacing: 20) {
                                    ForEach(members) { member in
                                        memberRow(member)
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 60)
                    .padding(.bottom, 60)
                }
                .background(Theme.background.ignoresSafeArea())
            }
        }
        .task { await load() }
    }

    @ViewBuilder
    private func trendingRow(_ show: PopularShow) -> some View {
        HStack(spacing: 20) {
            if let posterUrl = show.posterUrl, let url = URL(string: posterUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFill()
                } placeholder: {
                    Color.gray
                }
                .frame(width: 60, height: 90)
                .cornerRadius(8)
            } else {
                Color.gray
                    .frame(width: 60, height: 90)
                    .cornerRadius(8)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(show.title)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundColor(Theme.text)
                    .lineLimit(2)

                if !show.members.isEmpty {
                    Text("Added by: \(show.members.joined(separator: ", "))")
                        .font(.system(size: 18))
                        .foregroundColor(Theme.muted)
                        .lineLimit(1)
                }

                if let rating = show.rating {
                    Text("⭐ \(rating)")
                        .font(.system(size: 18))
                        .foregroundColor(Theme.muted)
                }
            }

            Spacer()
        }
        .padding(20)
        .background(Theme.cardBackground)
        .cornerRadius(12)
    }

    @ViewBuilder
    private func memberRow(_ member: GroupMember) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(member.displayName)
                .font(.system(size: 24, weight: .semibold))
                .foregroundColor(Theme.text)
            Text("\(member.showCount) show\(member.showCount == 1 ? "" : "s") • \(member.watchingCount) watching")
                .font(.system(size: 18))
                .foregroundColor(Theme.muted)
        }
        .padding(20)
        .background(Theme.cardBackground)
        .cornerRadius(12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let detail = try await API.groupDetail(id: groupId)
            self.group = detail.group
            self.members = detail.members
            let shows = try await API.groupTrending(id: groupId)
            self.trending = shows
        } catch {
            self.errorText = API.failureLine(error, action: "load group")
        }
    }
}

#Preview {
    GroupDetailViewTV(groupId: 1)
}
