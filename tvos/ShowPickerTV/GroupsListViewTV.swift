import SwiftUI
import ShowPickerCore

// Pushed onto Home's stack, so links push there — no path binding of its own.
//
// SwiftUI declares its own `Group`, so the model can't be named bare here.
// It's aliased rather than written as `ShowPickerCore.Group` inline: a
// qualified type inside a property-wrapper generic (`@State private var
// groups: [ClubGroup]`) is the shape that had the tvOS solver
// answering "failed to produce diagnostic" instead of type-checking.
private typealias ClubGroup = ShowPickerCore.Group
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

    // Split out of `body` deliberately. Four branches of styled stacks in one
    // expression is what made the tvOS type-checker give up with "failed to
    // produce diagnostic" — an error that comes and goes with build order
    // rather than with the code.
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
            Text("Use your iPhone or the web app to create or join a group")
                .font(.system(size: 20))
                .foregroundColor(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .center)
        .padding(.top, 40)
    }

    private var grid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 30), count: 3),
                  spacing: 30) {
            ForEach(groups) { group in
                NavigationLink(value: Route.groupDetail(group.id)) {
                    GroupTileTV(group: group)
                }
                .buttonStyle(PushButtonStyle())
            }
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

struct GroupTileTV: View {
    let group: ClubGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(group.name)
                .font(.system(size: 28, weight: .semibold))
                .foregroundColor(Theme.text)
                .lineLimit(2)

            Text("\(group.memberCount) member\(group.memberCount == 1 ? "" : "s")")
                .font(.system(size: 18))
                .foregroundColor(Theme.muted)

            Spacer()
        }
        .padding(30)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .frame(minHeight: 200)
        .background(Theme.cardBackground)
        .cornerRadius(16)
    }
}

#Preview {
    NavigationStack {
        GroupsListViewTV()
    }
}
