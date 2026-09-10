import SwiftUI
import ShowPickerCore

// `ClubGroup` (CoreImports.swift) is the model — SwiftUI has its own `Group`.
struct GroupDetailViewTV: View {
    let groupId: Int
    @State private var group: ClubGroup?
    @State private var members: [GroupMember] = []
    // The club roster, by slug: the group payload carries first names only, so
    // this supplies the display name and the Member value a row navigates with.
    @State private var roster: [String: Member] = [:]
    @State private var trending: [PopularShow] = []
    // The group's Watch Next board — read-only here, like everything else on
    // this app. Recommending and answering happen on iPhone/iPad.
    @State private var suggestions: [GroupSuggestion] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        ZStack {
            if loading {
                loadingState
            } else if let errorText {
                errorState(errorText)
            } else if let group {
                content(group)
            }
        }
        .task { await load() }
    }

    // Each state is its own expression rather than one inlined chain.
    private var loadingState: some View {
        VStack(spacing: 30) {
            ProgressView()
                .scaleEffect(2)
            Text("Loading…")
                .font(.system(size: 28))
                .foregroundColor(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 24) {
            Text(message)
                .font(.system(size: 28))
                .foregroundColor(Theme.muted)
            Button("Try again") { Task { await load() } }
                .font(.system(size: 24, weight: .semibold))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func content(_ group: ClubGroup) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                HStack(spacing: 24) {
                    GroupIconBadgeTV(icon: group.icon, color: group.color, size: 76)
                    VStack(alignment: .leading, spacing: 12) {
                        Text(group.name)
                            .font(.system(size: 56, weight: .bold))
                            .foregroundColor(Theme.text)
                        Text("\(members.count) member\(members.count == 1 ? "" : "s")")
                            .font(.system(size: 24))
                            .foregroundColor(Theme.muted)
                    }
                }
                .padding(.top, 20)

                // Stacked sections rather than a tab picker: the focus engine
                // always has something to land on. Members come first —
                // they're the answer to "whose group is this", and a short
                // horizontal row of them costs one band of screen instead of
                // pushing Trending below the fold.
                membersSection
                // Watch Next above Trending: a couch is where "what should
                // we watch next" actually gets asked, and this shelf is the
                // group's own answer. Hidden entirely while the board is
                // empty — an empty exhortation would just push Trending down.
                if !suggestions.isEmpty {
                    watchNextSection
                }
                trendingSection
            }
            .padding(.horizontal, 60)
            .padding(.bottom, 60)
        }
        .background(Theme.background.ignoresSafeArea())
    }

    private var watchNextSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionHeader("Watch Next")
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 40), count: 4),
                      spacing: 40) {
                ForEach(suggestions) { suggestion in
                    if let showId = suggestion.showId {
                        NavigationLink(value: Route.detail(id: showId, title: suggestion.title,
                                                           network: suggestion.network, rating: nil)) {
                            ShowCard(title: suggestion.title,
                                     subtitle: "Recommended by \(suggestion.suggestedByName)",
                                     networkLogoUrl: nil,
                                     posterUrl: suggestion.posterUrl)
                        }
                        .buttonStyle(PushButtonStyle())
                    } else {
                        // The recommender deleted their copy — the snapshot
                        // still names the show, there's just nowhere to push.
                        ShowCard(title: suggestion.title,
                                 subtitle: "Recommended by \(suggestion.suggestedByName)",
                                 networkLogoUrl: nil,
                                 posterUrl: suggestion.posterUrl)
                    }
                }
            }
            .padding(.vertical, 20)
        }
        // Let focus climb out of this grid to the Members shelf above or the
        // Trending grid below instead of wandering inside it, the same
        // treatment MemberView's shelves get.
        .focusSection()
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
                // Same reason as watchNextSection: keep focus from wandering
                // inside the grid instead of moving on to a neighboring
                // section.
                .focusSection()
            }
        }
    }

    // A horizontal band of member cards, the same shelf shape as Trending
    // rather than a column of full-width rows: a group is a handful of people,
    // and stacking them vertically spent the whole screen saying so.
    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            sectionHeader("Members")
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 30) {
                    ForEach(members) { member in
                        if let rosterMember = roster[member.slug] {
                            NavigationLink(value: Route.member(rosterMember)) {
                                memberCard(member, name: rosterMember.label)
                            }
                            .buttonStyle(PushButtonStyle())
                        } else {
                            // Roster miss: still listed, just not focusable —
                            // their lists wouldn't load anyway.
                            memberCard(member, name: member.displayName)
                        }
                    }
                }
                // Room for the focus lift, which otherwise clips at the edges.
                .padding(.horizontal, 14)
                .padding(.vertical, 20)
            }
        }
        // Let the tvOS focus engine move up/down between sections (and up to
        // the tab bar) instead of snagging inside this shelf — the same
        // treatment MemberView's own shelves get, and Watch Next/Trending
        // below get too.
        .focusSection()
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

    // Fixed width so the shelf reads as a row of equal cards; the counts wrap
    // onto their own line instead of the row's single "12 shows • 3 watching".
    @ViewBuilder
    private func memberCard(_ member: GroupMember, name: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(name)
                .font(.system(size: 26, weight: .semibold))
                .foregroundColor(Theme.text)
                .lineLimit(2)
            Text("\(member.showCount) show\(member.showCount == 1 ? "" : "s")")
                .font(.system(size: 18))
                .foregroundColor(Theme.muted)
            Text("\(member.watchingCount) watching")
                .font(.system(size: 18))
                .foregroundColor(Theme.muted)
        }
        .padding(24)
        .frame(width: 300, height: 170, alignment: .topLeading)
        .background(Theme.surface)
        .cornerRadius(16)
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
            // Non-fatally: a board that fails to load hides its shelf rather
            // than blanking the group.
            self.suggestions = (try? await API.groupSuggestions(groupId: groupId)) ?? []
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
