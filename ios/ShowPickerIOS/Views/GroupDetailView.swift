import SwiftUI
import UIKit
import ShowPickerCore

// SwiftUI declares its own `Group` (the view container), so the model type has
// to be spelled `ShowPickerCore.Group` in any file that imports both.
struct GroupDetailView: View {
    let groupId: Int
    @State private var group: ShowPickerCore.Group?
    @State private var members: [GroupMember] = []
    // The club roster, by slug. The group payload carries first names only, so
    // this is what gives a member row the same display name ("Dorothy") and
    // the same Member value the rest of the app navigates with.
    @State private var roster: [String: Member] = [:]
    @State private var trending: [PopularShow] = []
    @State private var loading = true
    @State private var errorText: String?
    @State private var selectedTab: Tab = .trending
    @State private var confirmingLeave = false
    @State private var confirmingDelete = false
    @State private var renaming = false
    @State private var renameText = ""
    // The invite itself is the presentation state. Held apart from a Bool flag
    // on purpose: see the `.sheet(item:)` note below.
    @State private var invite: GroupInvite?
    @State private var generatingInvite = false
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
                            if let rosterMember = roster[member.slug] {
                                NavigationLink(value: Route.member(rosterMember)) {
                                    memberRow(member, name: rosterMember.label)
                                }
                            } else {
                                // Roster miss (a disabled account, or the call
                                // failed): still list them, just not tappable —
                                // their lists wouldn't load anyway.
                                memberRow(member, name: member.displayName)
                            }
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
                        .disabled(generatingInvite)
                        Button {
                            confirmingLeave = true
                        } label: {
                            Label("Leave", systemImage: "arrowshape.turn.up.left")
                        }
                        if group.isCreator {
                            Button {
                                renameText = group.name
                                renaming = true
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
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
        .alert("Rename group", isPresented: $renaming) {
            TextField("Group name", text: $renameText)
            Button("Save") { Task { await rename() } }
            Button("Cancel", role: .cancel) { }
        }
        // `item:`, never `isPresented:`. The invite arrives and the sheet opens
        // in the same state update, and a Bool-driven sheet presents the body
        // captured *before* that update — which is how the first "Invite
        // members" tap showed an empty sheet and the second one showed the
        // link. Passing the invite in means the sheet can't render without it.
        .sheet(item: $invite) { invite in
            inviteSheet(invite)
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
    private func memberRow(_ member: GroupMember, name: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name)
                .font(.headline)
            Text("\(member.showCount) show\(member.showCount == 1 ? "" : "s") • \(member.watchingCount) watching")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func inviteSheet(_ invite: GroupInvite) -> some View {
        NavigationStack {
            VStack(spacing: 16) {
                VStack(spacing: 12) {
                    Text("Share this link to invite people")
                        .foregroundStyle(.secondary)
                    HStack {
                        Text(invite.url)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .truncationMode(.middle)
                            .lineLimit(1)
                        Spacer()
                        // A URL, not the String — plain text loses
                        // Messages, Mail and AirDrop from the share sheet.
                        if let link = URL(string: invite.url) {
                            ShareLink(item: link,
                                      subject: Text("Join my group on Show Picker"),
                                      message: Text("Join my group on Show Picker and we'll see what each other is watching.")) {
                                Image(systemName: "square.and.arrow.up")
                            }
                        }
                        Button {
                            UIPasteboard.general.string = invite.url
                        } label: {
                            Image(systemName: "doc.on.doc")
                        }
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))

                    if let expiry = Self.expiryLine(invite.expiresAt) {
                        Text("Expires on \(expiry)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding()
                Spacer()
            }
            .navigationTitle("Invite to Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { self.invite = nil }
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

            // Roster last and non-fatally: it only decides whether a member
            // row is tappable, so a failure here shouldn't blank the group.
            if let all = try? await API.members() {
                self.roster = Dictionary(uniqueKeysWithValues: all.map { ($0.slug, $0) })
            }
        } catch {
            self.errorText = API.failureLine(error, action: "load group")
            loading = false
        }
    }

    @MainActor
    private func rename() async {
        let name = renameText.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, name != group?.name else { return }
        do {
            group = try await API.renameGroup(id: groupId, name: name)
        } catch {
            self.errorText = API.failureLine(error, action: "rename group")
        }
    }

    @MainActor
    private func generateInvite() async {
        // Every call mints a new invite row server-side, so don't let a second
        // tap during the round trip mint a second one.
        guard !generatingInvite else { return }
        generatingInvite = true
        defer { generatingInvite = false }
        do {
            invite = try await API.generateGroupInvite(groupId: groupId)
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
