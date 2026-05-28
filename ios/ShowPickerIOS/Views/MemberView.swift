import SwiftUI

struct MemberView: View {
    let member: Member
    @EnvironmentObject private var auth: AuthStore
    @State private var shows: [Show] = []
    @State private var currentList: ShowList = .watching
    @State private var loading = true
    @State private var showingLogin = false
    @State private var showingAdd = false
    @State private var editingShow: Show?

    private var isMine: Bool { auth.isMe(member.slug) }

    var body: some View {
        VStack(spacing: 0) {
            Picker("List", selection: $currentList) {
                ForEach(ShowList.allCases) { l in Text(l.title).tag(l) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.top, 8)

            List {
                let items = shows.filter { $0.list == currentList.rawValue && !$0.isArchived }
                    .sorted { (Double($0.rating ?? "0") ?? 0) > (Double($1.rating ?? "0") ?? 0) }
                if items.isEmpty {
                    Text("No shows on this list.")
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(items) { show in
                        NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                            row(show)
                        }
                        .swipeActions(edge: .trailing) {
                            if isMine {
                                Button(role: .destructive) {
                                    Task { try? await API.archiveShow(id: show.id); await load() }
                                } label: { Label("Archive", systemImage: "archivebox") }
                                Button {
                                    editingShow = show
                                } label: { Label("Edit", systemImage: "pencil") }
                                    .tint(.blue)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("\(member.label)'s Shows")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if isMine {
                    Button { showingAdd = true } label: { Image(systemName: "plus") }
                } else if auth.isLoggedIn {
                    Menu {
                        Button { showingAdd = true } label: { Label("Suggest a show", systemImage: "paperplane") }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                } else {
                    Button("Log in") { showingLogin = true }
                }
            }
        }
        .refreshable { await load() }
        .task { if loading { await load() } }
        .overlay { if loading && shows.isEmpty { ProgressView() } }
        .sheet(isPresented: $showingLogin) {
            LoginView(memberSlug: member.slug).environmentObject(auth)
        }
        .sheet(isPresented: $showingAdd) {
            if isMine {
                AddEditShowView(memberSlug: member.slug, existing: nil) { await load() }
            } else {
                SuggestShowView(targetSlug: member.slug, targetName: member.label)
            }
        }
        .sheet(item: $editingShow) { show in
            AddEditShowView(memberSlug: member.slug, existing: show) { await load() }
        }
    }

    @ViewBuilder private func row(_ s: Show) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.title).font(.body)
                    if s.isFullSeries { Text("🎬") }
                }
                HStack(spacing: 6) {
                    if let n = s.network, !n.isEmpty {
                        Text(n).foregroundStyle(.secondary)
                    }
                    if let by = s.recommendedBy, !by.isEmpty, currentList == .next {
                        Text("· rec'd by \(by)").foregroundStyle(.secondary)
                    }
                }
                .font(.caption)
            }
            Spacer()
            if let r = s.rating, !r.isEmpty {
                Label(r, systemImage: "star.fill")
                    .font(.caption)
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        shows = (try? await API.shows(member: member.slug)) ?? []
    }
}
