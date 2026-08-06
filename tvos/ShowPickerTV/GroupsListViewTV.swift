import SwiftUI
import ShowPickerCore

// The Groups tab's root. No path binding of its own, so links push onto the
// stack hosting it.
//
// View-only, like the rest of tvOS: creating, joining, renaming, inviting and
// leaving all happen on the phone, iPad or Mac. That isn't discoverable from
// a screen that only lists things, so both states say where to go.
// `ClubGroup` (CoreImports.swift) is the model — SwiftUI has its own `Group`.
struct GroupsListViewTV: View {
    @State private var groups: [ClubGroup] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 40) {
                Text("Groups")
                    .font(.system(size: 56, weight: .bold))
                    .foregroundColor(Theme.text)
                    .padding(.top, 20)

                content

                Text("Ratings and metadata from IMDb (via OMDb) and TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.")
                    .font(.system(size: 18))
                    .foregroundColor(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
            .padding(.horizontal, 60)
            .padding(.bottom, 60)
        }
        .background(Theme.background.ignoresSafeArea())
        .task { if groups.isEmpty { await load() } }
    }

    @ViewBuilder private var content: some View {
        if loading {
            ProgressView()
                .padding(.top, 80)
                .frame(maxWidth: .infinity)
        } else if let errorText {
            errorState(errorText)
        } else if groups.isEmpty {
            emptyState
        } else {
            grid
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 24) {
            Text(message)
                .font(.system(size: 28))
                .foregroundColor(Theme.muted)
            Button("Try again") { Task { await load() } }
                .font(.system(size: 24, weight: .semibold))
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    private var emptyState: some View {
        VStack(spacing: 24) {
            Text("No groups yet")
                .font(.system(size: 28))
                .foregroundColor(Theme.muted)
            // Was "or the web app" — the web member app was retired in
            // 2026-08 and there's nothing there to send anyone to.
            Text("Create or join a group on your iPhone, iPad or Mac, and it'll show up here.")
                .font(.system(size: 20))
                .foregroundColor(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 40)
    }

    // The same fact for someone who already has groups: nothing on this screen
    // manages them, and the reason is that the TV doesn't do it at all.
    private var manageNote: some View {
        Text("Create groups, invite people, and rename or leave them on your iPhone, iPad or Mac.")
            .font(.system(size: 20))
            .foregroundColor(Theme.muted)
    }

    private var grid: some View {
        VStack(alignment: .leading, spacing: 24) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 24), count: 4),
                      spacing: 24) {
                ForEach(groups) { group in
                    NavigationLink(value: Route.groupDetail(group.id)) {
                        GroupTileTV(group: group)
                    }
                    .buttonStyle(PushButtonStyle())
                }
            }
            manageNote
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            let response = try await API.groups()
            groups = response.groups
        } catch {
            errorText = API.failureLine(error, action: "load groups")
        }
    }
}

// Two short lines of text, so the tile is sized by them: no Spacer holding it
// open to a 200pt minimum. A name and a member count don't need a card the
// size of a poster, and four across reads as a set rather than as four
// billboards.
struct GroupTileTV: View {
    let group: ClubGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(group.name)
                .font(.system(size: 26, weight: .semibold))
                .foregroundColor(Theme.text)
                .lineLimit(1)

            Text("\(group.memberCount) member\(group.memberCount == 1 ? "" : "s")")
                .font(.system(size: 18))
                .foregroundColor(Theme.muted)
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface)
        .cornerRadius(14)
    }
}

#Preview {
    NavigationStack {
        GroupsListViewTV()
    }
}
