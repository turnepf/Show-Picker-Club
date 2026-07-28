import SwiftUI
import ShowPickerCore

struct GroupsWatchView: View {
    @EnvironmentObject private var auth: WatchAuth
    @State private var groups: [Group] = []
    @State private var loading = false
    @State private var errorText: String?

    var body: some View {
        Group {
            if loading && groups.isEmpty {
                ProgressView()
            } else if let errorText, groups.isEmpty {
                VStack(spacing: 8) {
                    Text(errorText).font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Try Again") { Task { await load() } }
                        .font(.caption)
                }
                .padding(.horizontal)
            } else if groups.isEmpty {
                Text("No groups").font(.caption).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding()
            } else {
                List {
                    ForEach(groups) { group in
                        NavigationLink(value: group) {
                            HStack(spacing: 8) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(group.name).font(.body)
                                    Text("\(group.memberCount) member\(group.memberCount == 1 ? "" : "s")")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Groups")
        .navigationDestination(for: Group.self) { group in
            GroupDetailWatchView(group: group)
        }
        .task { await load() }
    }

    private func load() async {
        guard auth.isLoggedIn else { return }
        loading = true
        defer { loading = false }
        do {
            groups = try await WatchAPI.groups(cookie: auth.cookieHeader)
            errorText = nil
        } catch {
            errorText = "Couldn't load groups."
        }
    }
}
