import SwiftUI
import ShowPickerCore

// Pushed onto the host's stack (HomeView on iPhone, the iPad detail column), so
// it pushes group detail through the binding it's handed rather than owning a
// nested NavigationStack of its own. SwiftUI's own `Group` means the model type
// has to be spelled `ShowPickerCore.Group` here.
struct GroupsListView: View {
    @Binding var path: [Route]
    @State private var groups: [ShowPickerCore.Group] = []
    @State private var loading = true
    @State private var errorText: String?
    @State private var showingCreate = false
    @State private var showingJoin = false
    @State private var newGroupName = ""
    @State private var newGroupIcon: String?
    @State private var newGroupColor: String?
    @State private var joinToken = ""

    var body: some View {
        VStack(spacing: 0) {
            if loading {
                VStack {
                    ProgressView()
                        .scaleEffect(1.5)
                    Text("Loading groups…")
                        .foregroundStyle(.secondary)
                        .padding(.top, 12)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground))
            } else if let errorText = errorText {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.largeTitle)
                        .foregroundStyle(.orange)
                    Text("Couldn't load groups")
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
                .background(Color(.systemBackground))
            } else if groups.isEmpty {
                VStack(spacing: 16) {
                    Image(systemName: "person.2.crop.square.stack")
                        .font(.system(size: 48))
                        .foregroundStyle(.secondary)
                    Text("No groups yet")
                        .font(.headline)
                    Text("Create a group to get started")
                        .foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button {
                            showingCreate = true
                        } label: {
                            Label("Create", systemImage: "plus")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        Button {
                            showingJoin = true
                        } label: {
                            Label("Join", systemImage: "person.badge.plus")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                    }
                }
                .padding()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemBackground))
            } else {
                List(groups) { group in
                    NavigationLink(value: Route.groupDetail(group.id)) {
                        HStack(spacing: 12) {
                            GroupIconBadge(icon: group.icon, color: group.color)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(group.name)
                                    .font(.headline)
                                Text("\(group.memberCount) member\(group.memberCount == 1 ? "" : "s")")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .navigationTitle("Groups")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button {
                        showingCreate = true
                    } label: {
                        Label("Create group", systemImage: "plus")
                    }
                    Button {
                        showingJoin = true
                    } label: {
                        Label("Join group", systemImage: "person.badge.plus")
                    }
                } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showingCreate) {
            createGroupSheet
        }
        .sheet(isPresented: $showingJoin) {
            joinGroupSheet
        }
        .task {
            await load()
        }
    }

    @ViewBuilder
    private var createGroupSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        GroupIconBadge(icon: newGroupIcon, color: newGroupColor, size: 44)
                        TextField("Group name", text: $newGroupName)
                            .textFieldStyle(.roundedBorder)
                    }
                    Text("Pick an icon so the group is recognizable at a glance — you can change it any time.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    GroupIconPicker(icon: $newGroupIcon, color: $newGroupColor)
                }
                .padding()
            }
            .navigationTitle("Create Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingCreate = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        Task {
                            await createGroup()
                        }
                    }
                    .disabled(newGroupName.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    @ViewBuilder
    private var joinGroupSheet: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Text("Enter the invite code to join a group")
                    .foregroundStyle(.secondary)
                TextField("Invite code", text: $joinToken)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding()
                Spacer()
            }
            .navigationTitle("Join Group")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { showingJoin = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Join") {
                        Task {
                            await joinGroup()
                        }
                    }
                    .disabled(joinToken.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }

    @MainActor
    private func load() async {
        loading = true
        errorText = nil
        do {
            let response = try await API.groups()
            self.groups = response.groups
            loading = false
        } catch {
            self.errorText = API.failureLine(error, action: "load groups")
            loading = false
        }
    }

    @MainActor
    private func createGroup() async {
        let name = newGroupName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }

        do {
            let (group, _) = try await API.createGroup(name: name, icon: newGroupIcon, color: newGroupColor)
            newGroupName = ""
            newGroupIcon = nil
            newGroupColor = nil
            showingCreate = false
            await load()
            path.append(.groupDetail(group.id))
        } catch {
            self.errorText = API.failureLine(error, action: "create group")
        }
    }

    @MainActor
    private func joinGroup() async {
        let token = joinToken.trimmingCharacters(in: .whitespaces)
        guard !token.isEmpty else { return }

        do {
            let result = try await API.joinGroup(token: token)
            joinToken = ""
            showingJoin = false
            await load()
            path.append(.groupDetail(result.groupId))
        } catch {
            self.errorText = API.failureLine(error, action: "join group")
        }
    }
}

#Preview {
    NavigationStack {
        GroupsListView(path: .constant([]))
    }
}
