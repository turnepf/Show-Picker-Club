import SwiftUI
import UIKit
import ShowPickerCore

// SwiftUI declares its own `Group` (the view container), so the model type has
// to be spelled `ShowPickerCore.Group` in any file that imports both.
struct GroupDetailView: View {
    let groupId: Int
    @State private var group: ShowPickerCore.Group?
    @State private var members: [GroupMember] = []
    @State private var trending: [PopularShow] = []
    @State private var loading = true
    @State private var errorText: String?
    @State private var selectedTab: Tab = .trending
    @State private var showingInvite = false
    @State private var confirmingLeave = false
    @State private var confirmingDelete = false
    @State private var inviteUrl: String?
    @State private var inviteExpiry: String?
    @Environment(\.dismiss) private var dismiss

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
            } else if let errorText = errorText {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.orange)
                    Text("Couldn't load group")
                        .font(.headline)
                    Text(errorText)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Button("Try again") {
                        Task { await load() }
                    }
                    .buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if group != nil {
                VStack(spacing: 0) {
                    Text("\(members.count) member\(members.count == 1 ? "" : "s")")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal)
                        .padding(.top, 8)

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
                            List(trending) { show in
                                NavigationLink(value: Route.detail(id: show.id, title: show.title,
                                                                   network: show.network, rating: show.rating)) {
                                    ShowRow(show, caption: addedByCaption(show))
                                }
                            }
                        }
                    } else {
                        List(members) { member in
                            memberRow(member)
                        }
                    }
                }
            }
        }
        .navigationTitle(group?.name ?? "Group")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let group = group {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button {
                            Task { await generateInvite() }
                        } label: {
                            Label("Invite members", systemImage: "person.badge.plus")
                        }
                        Button {
                            confirmingLeave = true
                        } label: {
                            Label("Leave", systemImage: "arrowshape.turn.up.left")
                        }
                        if group.isCreator {
                            Button(role: .destructive) {
                                confirmingDelete = true
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                }
            }
        }
        .confirmationDialog("Leave this group?", isPresented: $confirmingLeave, titleVisibility: .visible) {
            Button("Leave", role: .destructive) { Task { await leaveGroup() } }
            Button("Cancel", role: .cancel) { }
        }
        .confirmationDialog("Delete this group?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) { Task { await deleteGroup() } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This can't be undone. Nobody in the group keeps access.")
        }
        .sheet(isPresented: $showingInvite) {
            inviteSheet
        }
        .task {
            await load()
        }
    }

    // The server stamps expires_at with Date#toISOString, so it carries
    // fractional seconds that a default ISO8601DateFormatter won't parse.
    private static func expiryLine(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = parser.date(from: iso)
        if date == nil {
            parser.formatOptions = [.withInternetDateTime]
            date = parser.date(from: iso)
        }
        guard let date else { return nil }
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return formatter.string(from: date)
    }

    // Trending's caption says whose lists a title is on; ShowRow falls back to
    // the network line when the endpoint sent no members.
    private func addedByCaption(_ show: PopularShow) -> String? {
        guard let names = show.members, !names.isEmpty else { return nil }
        return "Added by: \(names.joined(separator: ", "))"
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
                            ShareLink(item: url) {
                                Image(systemName: "square.and.arrow.up")
                            }
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
        errorText = nil
        do {
            let detail = try await API.groupDetail(id: groupId)
            self.group = detail.group
            self.members = detail.members

            let shows = try await API.groupTrending(id: groupId)
            self.trending = shows
            loading = false
        } catch {
            self.errorText = API.failureLine(error, action: "load group")
            loading = false
        }
    }

    @MainActor
    private func generateInvite() async {
        do {
            let invite = try await API.generateGroupInvite(groupId: groupId)
            inviteUrl = invite.url
            inviteExpiry = Self.expiryLine(invite.expiresAt)
            showingInvite = true
        } catch {
            self.errorText = API.failureLine(error, action: "generate invite")
        }
    }

    @MainActor
    private func leaveGroup() async {
        do {
            _ = try await API.leaveGroup(id: groupId)
            dismiss()
        } catch {
            self.errorText = API.failureLine(error, action: "leave group")
        }
    }

    @MainActor
    private func deleteGroup() async {
        do {
            _ = try await API.deleteGroup(id: groupId)
            dismiss()
        } catch {
            self.errorText = API.failureLine(error, action: "delete group")
        }
    }
}

#Preview {
    NavigationStack {
        GroupDetailView(groupId: 1)
    }
}
