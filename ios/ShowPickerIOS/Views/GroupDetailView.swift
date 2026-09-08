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
    // The group's recommendation board, shaped for me by the server.
    @State private var suggestions: [GroupSuggestion] = []
    // The card the pop-up is currently asking about — "JC has recommended
    // Lanterns", Dismiss / Add to Next Up. Advanced through the unanswered
    // cards one at a time; nil when the queue is empty.
    @State private var pendingPopup: GroupSuggestion?
    @State private var responding = false
    @State private var loading = true
    @State private var errorText: String?
    @State private var selectedTab: Tab = .trending
    @State private var confirmingLeave = false
    @State private var confirmingDelete = false
    // Set from the detail load, shown once at the top of the screen, then
    // gone — the server itself only ever sends this once per member per
    // change (see load()).
    @State private var changeNotice: GroupChangeNotice?
    @State private var renaming = false
    @State private var renameText = ""
    // "Change icon" drafts — seeded from the group when the sheet opens, saved
    // in one PATCH so backing out changes nothing.
    @State private var editingIcon = false
    @State private var iconDraft: String?
    @State private var colorDraft: String?
    @State private var savingIcon = false
    // The invite itself is the presentation state. Held apart from a Bool flag
    // on purpose: see the `.sheet(item:)` note below.
    @State private var invite: GroupInvite?
    @State private var generatingInvite = false
    @Environment(\.dismiss) private var dismiss

    enum Tab {
        case trending
        case watchNext
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
                    if let changeNotice = changeNotice {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "info.circle.fill")
                                .foregroundStyle(.blue)
                            Text(changeNotice.summary)
                                .font(.subheadline)
                            Spacer(minLength: 0)
                        }
                        .padding(12)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .padding(.horizontal)
                        .padding(.top, 8)
                    }

                    HStack(spacing: 10) {
                        GroupIconBadge(icon: group?.icon, color: group?.color, size: 30)
                        Text("\(members.count) member\(members.count == 1 ? "" : "s")")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal)
                    .padding(.top, 8)

                    Picker("Tab", selection: $selectedTab) {
                        Text("Trending").tag(Tab.trending)
                        Text("Watch Next").tag(Tab.watchNext)
                        Text("Members").tag(Tab.members)
                    }
                    .pickerStyle(.segmented)
                    .padding()

                    if selectedTab == .watchNext {
                        if suggestions.isEmpty {
                            VStack(spacing: 12) {
                                Image(systemName: "megaphone")
                                    .font(.largeTitle)
                                    .foregroundStyle(.secondary)
                                Text("No recommendations yet")
                                    .foregroundStyle(.secondary)
                                Text("Recommend a show from its detail page and the group sees it here.")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                                    .padding(.horizontal, 32)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            List(suggestions) { suggestion in
                                suggestionRow(suggestion)
                            }
                        }
                    } else if selectedTab == .trending {
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
                        // Rename and Change icon are open to any group
                        // member, not just the creator — the other members
                        // find out via the change notice above, the next
                        // time they open the group. Delete stays
                        // creator-only.
                        Button {
                            renameText = group.name
                            renaming = true
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        Button {
                            iconDraft = group.icon
                            colorDraft = group.color
                            editingIcon = true
                        } label: {
                            Label("Change icon", systemImage: "face.smiling")
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
        .alert("Rename group", isPresented: $renaming) {
            TextField("Group name", text: $renameText)
            Button("Save") { Task { await rename() } }
            Button("Cancel", role: .cancel) { }
        }
        // JC's pop-up, verbatim: "JC has recommended Lanterns" with two
        // buttons — Dismiss or Add to Next Up. One card at a time; both
        // answers are per-member marks on the server, so dismissing here
        // hides it for me and nobody else, and the card stays on the Watch
        // Next board either way.
        .alert(pendingPopup.map { "\($0.suggestedByName) has recommended \($0.title)" } ?? "",
               isPresented: Binding(get: { pendingPopup != nil }, set: { if !$0 { pendingPopup = nil } }),
               presenting: pendingPopup) { suggestion in
            Button("Add to Next Up") { Task { await respondToPopup(suggestion, response: "add") } }
            Button("Dismiss", role: .cancel) { Task { await respondToPopup(suggestion, response: "dismiss") } }
        } message: { suggestion in
            if let note = suggestion.note, !note.isEmpty {
                Text("“\(note)”")
            }
        }
        // `item:`, never `isPresented:`. The invite arrives and the sheet opens
        // in the same state update, and a Bool-driven sheet presents the body
        // captured *before* that update — which is how the first "Invite
        // members" tap showed an empty sheet and the second one showed the
        // link. Passing the invite in means the sheet can't render without it.
        .sheet(item: $invite) { invite in
            inviteSheet(invite)
        }
        .sheet(isPresented: $editingIcon) {
            iconSheet
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

    // One card on the Watch Next board. Tappable through to the show's
    // detail screen while the recommender's copy exists — the same
    // cross-member id Trending rows navigate with — and a plain card once
    // they've deleted it (the snapshot still names and pictures the show).
    @ViewBuilder
    private func suggestionRow(_ suggestion: GroupSuggestion) -> some View {
        SwiftUI.Group {
            if let showId = suggestion.showId {
                NavigationLink(value: Route.detail(id: showId, title: suggestion.title,
                                                   network: suggestion.network, rating: nil)) {
                    suggestionCard(suggestion)
                }
            } else {
                suggestionCard(suggestion)
            }
        }
        .swipeActions(edge: .trailing) {
            // The same two hands the server allows: the recommender
            // retracting their own card, or the creator tidying the board.
            if suggestion.isYours || (group?.isCreator ?? false) {
                Button(role: .destructive) {
                    Task { await removeSuggestion(suggestion) }
                } label: {
                    Label("Remove", systemImage: "trash")
                }
            }
        }
    }

    @ViewBuilder
    private func suggestionCard(_ suggestion: GroupSuggestion) -> some View {
        HStack(alignment: .top, spacing: 12) {
            PosterThumb(url: suggestion.posterUrl, width: 45, height: 68)
            VStack(alignment: .leading, spacing: 4) {
                Text(suggestion.title)
                    .font(.headline)
                Text(suggestion.isYours ? "Your recommendation"
                                        : "Recommended by \(suggestion.suggestedByName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let note = suggestion.note, !note.isEmpty {
                    Text("“\(note)”")
                        .font(.caption)
                        .italic()
                        .foregroundStyle(.secondary)
                }
                if !suggestion.addedNames.isEmpty {
                    Text("Added by \(suggestion.addedNames.joined(separator: ", "))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                suggestionStatus(suggestion)
            }
        }
        .padding(.vertical, 4)
    }

    // The card's action line: a checkmark once the title is on one of my
    // lists, otherwise the same Add-to-Next-Up the pop-up offers — a dismiss
    // isn't final, so the board keeps the door open.
    @ViewBuilder
    private func suggestionStatus(_ suggestion: GroupSuggestion) -> some View {
        if let list = suggestion.onYourList, let l = ShowList(rawValue: list) {
            Label("On your \(l.title) list", systemImage: "checkmark")
                .font(.caption)
                .foregroundStyle(.green)
        } else if !suggestion.isYours {
            Button {
                Task { await respond(suggestion, response: "add") }
            } label: {
                Label("Add to Next Up", systemImage: "plus")
                    .font(.caption.weight(.semibold))
            }
            .buttonStyle(.borderless)
            .tint(.orange)
            .disabled(responding)
        }
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

    // The group's own name for the invite share. The fallback only applies
    // while the group is still loading — by the time an invite sheet is open
    // it has been fetched.
    private var shareGroupName: String {
        let name = (group?.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "my group" : name
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
                        //
                        // The group is named rather than called "my group":
                        // the recipient is deciding whether to tap, and
                        // "Join Thursday Night Club" tells them what this is.
                        // The card they actually see is built by
                        // functions/groups/join.js, which resolves the same
                        // name from the token — nothing set here reaches it.
                        if let link = URL(string: invite.url) {
                            ShareLink(item: link,
                                      subject: Text("Join \(shareGroupName) on Show Picker Club"),
                                      message: Text("Join \(shareGroupName) on Show Picker Club and we'll see what each other is watching."),
                                      preview: SharePreview("Join \(shareGroupName) on Show Picker Club")) {
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
            self.changeNotice = detail.changeNotice

            let shows = try await API.groupTrending(id: groupId)
            self.trending = shows
            loading = false

            // Non-fatally, like the roster below: a board that fails to load
            // shouldn't blank the group. Then start the pop-up queue — this
            // screen opening IS the delivery moment for "JC has recommended
            // Lanterns" (there's no push infrastructure, by design).
            if let board = try? await API.groupSuggestions(groupId: groupId) {
                self.suggestions = board
                advancePopup()
            }

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

    // The next unanswered card that isn't mine, if any.
    private func advancePopup() {
        pendingPopup = suggestions.first { $0.needsResponse }
    }

    // Answer from the pop-up: record it, then ask about the next card. A
    // failed save ends the queue for this visit instead of re-presenting the
    // same alert — the card stays unanswered server-side, so the next visit
    // asks again.
    @MainActor
    private func respondToPopup(_ suggestion: GroupSuggestion, response: String) async {
        if await respond(suggestion, response: response) {
            advancePopup()
        }
    }

    // Answer a card — "dismiss" or "add". Both are marks about ME on the
    // server; "add" also puts the title on my own Next Up (or finds the copy
    // I already have).
    @MainActor
    @discardableResult
    private func respond(_ suggestion: GroupSuggestion, response: String) async -> Bool {
        guard !responding else { return false }
        responding = true
        defer { responding = false }
        guard let updated = try? await API.respondToGroupSuggestion(
            groupId: groupId, suggestionId: suggestion.id, response: response) else { return false }
        if let i = suggestions.firstIndex(where: { $0.id == updated.id }) {
            suggestions[i] = updated
        }
        return true
    }

    @MainActor
    private func removeSuggestion(_ suggestion: GroupSuggestion) async {
        do {
            _ = try await API.removeGroupSuggestion(groupId: groupId, suggestionId: suggestion.id)
            suggestions.removeAll { $0.id == suggestion.id }
        } catch {
            self.errorText = API.failureLine(error, action: "remove recommendation")
        }
    }

    @ViewBuilder
    private var iconSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        GroupIconBadge(icon: iconDraft, color: colorDraft, size: 44)
                        Text(group?.name ?? "Group")
                            .font(.headline)
                    }
                    GroupIconPicker(icon: $iconDraft, color: $colorDraft)
                }
                .padding()
            }
            .navigationTitle("Group Icon")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { editingIcon = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await saveIcon() } }
                        .disabled(savingIcon)
                }
            }
        }
    }

    @MainActor
    private func saveIcon() async {
        guard !savingIcon else { return }
        savingIcon = true
        defer { savingIcon = false }
        do {
            group = try await API.setGroupIcon(id: groupId, icon: iconDraft, color: colorDraft)
            editingIcon = false
        } catch {
            self.errorText = API.failureLine(error, action: "save group icon")
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
