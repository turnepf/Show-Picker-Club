import SwiftUI
import ShowPickerCore

// SwiftUI has its own `Group`, so the model needs qualifying in type position.
struct GroupDetailViewTV: View {
    let groupId: Int
    @State private var group: ShowPickerCore.Group?
    @State private var members: [GroupMember] = []
    // The club roster, by slug: the group payload carries first names only, so
    // this supplies the display name and the Member value a row navigates with.
    @State private var roster: [String: Member] = [:]
    @State private var trending: [PopularShow] = []
    @State private var loading = true
    @State private var errorText: String?

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

                        // Stacked sections rather than a tab picker: the same
                        // shape as a member's screen, and the focus engine
                        // always has something to land on.
                        trendingSection
                        membersSection
                    }
                    .padding(.horizontal, 60)
                    .padding(.bottom, 60)
                }
                .background(Theme.background.ignoresSafeArea())
            }
        }
        .task { await load() }
    }

    private var trendingSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionHeader("Trending")
            if trending.isEmpty {
                Text("Nobody in this group has added a show yet.")
                    .font(.system(size: 24))
                    .foregroundColor(Theme.muted)
            } else {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 40), count: 4),
                          spacing: 40) {
                    ForEach(trending) { show in
                        NavigationLink(value: Route.detail(id: show.id, title: show.title,
                                                           network: show.network, rating: show.rating)) {
                            ShowCard(title: show.title,
                                     subtitle: addedBy(show),
                                     networkLogoUrl: show.networkLogoUrl,
                                     posterUrl: show.posterUrl)
                        }
                        .buttonStyle(PushButtonStyle())
                    }
                }
                .padding(.vertical, 20)
            }
        }
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionHeader("Members")
            LazyVStack(alignment: .leading, spacing: 20) {
                ForEach(members) { member in
                    if let rosterMember = roster[member.slug] {
                        NavigationLink(value: Route.member(rosterMember)) {
                            memberRow(member, name: rosterMember.label)
                        }
                        .buttonStyle(PushButtonStyle())
                    } else {
                        // Roster miss: still listed, just not focusable —
                        // their lists wouldn't load anyway.
                        memberRow(member, name: member.displayName)
                    }
                }
            }
        }
    }

    private func sectionHeader(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 32, weight: .semibold))
            .foregroundColor(Theme.text)
    }

    // Whose lists a title is on — the one thing a group card says that the
    // Home shelf's card doesn't. nil when the endpoint sent no members.
    private func addedBy(_ show: PopularShow) -> String? {
        guard let names = show.members, !names.isEmpty else { return nil }
        return names.joined(separator: ", ")
    }

    @ViewBuilder
    private func memberRow(_ member: GroupMember, name: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name)
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
            // Roster last and non-fatally: it only decides whether a member
            // row opens their lists, so a failure here shouldn't blank the group.
            if let all = try? await API.members() {
                self.roster = Dictionary(uniqueKeysWithValues: all.map { ($0.slug, $0) })
            }
        } catch {
            self.errorText = API.failureLine(error, action: "load group")
        }
    }
}

#Preview {
    NavigationStack {
        GroupDetailViewTV(groupId: 1)
    }
}
