import SwiftUI
import ShowPickerCore

struct GroupDetailView: View {
    let groupId: Int
    @State private var group: Group?
    @State private var members: [GroupMember] = []
    @State private var trending: [PopularShow] = []
    @State private var loading = true
    @State private var error: String?
    @State private var selectedTab: Tab = .trending
    @State private var showingInvite = false
    @State private var showingMenu = false
    @State private var inviteUrl: String?
    @State private var inviteExpiry: String?
    @Environment(\.dismiss) var dismiss

    enum Tab {
        case trending
        case members
    }

    var body: some View {
        ZStack {
            if loading {
                VStack {
                    ProgressView()
                        .scaleEffect(1.5)
                    Text("Loading…")
                        .foregroundStyle(.secondary)
                        .padding(.top, 12)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = error {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.orange)
                    Text("Couldn't load group")
                        .font(.headline)
                    Text(error)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button("Try again") {
                        Task { await load() }
                    }
                    .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let group = group {
                VStack(spacing: 0) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(group.name)
                                    .font(.title2.bold())
                                Text("\(members.count) member\(members.count == 1 ? "" : "s")")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            Menu {
                                Button(action: { Task { await generateInvite() } }) {
                                    Label("Invite members", systemImage: "person.badge.plus")
                                }
                                Button(action: { Task { await leaveGroup() } }) {
                                    Label("Leave", systemImage: "arrowshape.turn.up.left")
                                }
                                if group.isCreator {
                                    Button(action: { Task { await deleteGroup() } }, role: .destructive) {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                            } label: {
                                Image(systemName: "ellipsis")
                                    .font(.title3)
                            }
                        }
                        .padding()
                    }
                    .background(Color(.secondarySystemBackground))

                    Picker("Tab", selection: $selectedTab) {
                        Text("Trending").tag(Tab.trending)
                        Text("Members").tag(Tab.members)
                    }
                    .pickerStyle(.segmented)
                    .padding()

                    if selectedTab == .trending {
                        if trending.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "flame")
                                    .font(.largeTitle)
                                    .foregroundStyle(.secondary)
                                Text("No shows yet")
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            List {
                                ForEach(trending) { show in
                                    trendingRow(show)
                                }
                            }
                        }
                    } else {
                        List {
                            ForEach(members) { member in
                                memberRow(member)
                            }
                        }
                    }
                }
            }
        }
        .navigationBarBackButtonHidden(false)
        .sheet(isPresented: $showingInvite) {
            inviteSheet
        }
        .task {
            await load()
        }
    }

    @ViewBuilder
    private func trendingRow(_ show: PopularShow) -> some View {
        HStack(spacing: 12) {
            if let posterUrl = show.posterUrl, let url = URL(string: posterUrl) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFill()
                } placeholder: {
                    Color.gray
                }
                .frame(width: 40, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                Color.gray
                    .frame(width: 40, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(show.title)
                    .font(.headline)
                    .lineLimit(2)
                if !show.members.isEmpty {
                    Text("Added by: \(show.members.joined(separator: ", "))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                if let rating = show.rating {
                    Text("⭐ \(rating)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func memberRow(_ member: GroupMember) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(member.displayName)
                .font(.headline)
            Text("\(member.showCount) show\(member.showCount == 1 ? "" : "s") • \(member.watchingCount) watching")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private var inviteSheet: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let url = inviteUrl {
                    VStack(spacing: 12) {
                        Text("Share this link to invite people")
                            .foregroundStyle(.secondary)
                        HStack {
                            Text(url)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .truncationMode(.middle)
                                .lineLimit(1)
                            Spacer()
                            Button {
                                UIPasteboard.general.string = url
                            } label: {
                                Image(systemName: "doc.on.doc")
                            }
                        }
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 8))

                        if let expiry = inviteExpiry {
                            Text("Expires on \(expiry)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding()
                    Spacer()
                }
            }
            .navigationTitle("Invite to Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingInvite = false }
                }
            }
        }
    }

    @MainActor
    private func load() async {
        loading = true
        error = nil
        do {
            let detail = try await API.groupDetail(id: groupId)
            self.group = detail.group
            self.members = detail.members

            let shows = try await API.groupTrending(id: groupId)
            self.trending = shows
            loading = false
        } catch {
            self.error = API.failureLine(error, action: "load group")
            loading = false
        }
    }

    @MainActor
    private func generateInvite() async {
        do {
            let invite = try await API.generateGroupInvite(groupId: groupId)
            inviteUrl = invite.url
            let date = ISO8601DateFormatter().date(from: invite.expiresAt)
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            inviteExpiry = date.map { formatter.string(from: $0) }
            showingInvite = true
        } catch {
            error = API.failureLine(error, action: "generate invite")
        }
    }

    @MainActor
    private func leaveGroup() async {
        let alert = UIAlertController(
            title: "Leave Group",
            message: "Are you sure you want to leave this group?",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Leave", style: .destructive) { _ in
            Task {
                do {
                    _ = try await API.leaveGroup(id: groupId)
                    dismiss()
                } catch {
                    error = API.failureLine(error, action: "leave group")
                }
            }
        })
        if let scene = UIApplication.shared.connectedScenes.first,
           let window = (scene as? UIWindowScene)?.windows.first,
           let rootVC = window.rootViewController {
            rootVC.present(alert, animated: true)
        }
    }

    @MainActor
    private func deleteGroup() async {
        let alert = UIAlertController(
            title: "Delete Group",
            message: "Are you sure? This can't be undone.",
            preferredStyle: .alert
        )
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Delete", style: .destructive) { _ in
            Task {
                do {
                    _ = try await API.deleteGroup(id: groupId)
                    dismiss()
                } catch {
                    error = API.failureLine(error, action: "delete group")
                }
            }
        })
        if let scene = UIApplication.shared.connectedScenes.first,
           let window = (scene as? UIWindowScene)?.windows.first,
           let rootVC = window.rootViewController {
            rootVC.present(alert, animated: true)
        }
    }
}

#Preview {
    GroupDetailView(groupId: 1)
}
