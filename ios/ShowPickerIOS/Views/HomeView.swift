import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true
    @State private var showingLogin = false
    @State private var showingSearch = false
    @State private var showAllMembers = false
    @State private var shakePick: Show?

    private let memberPreviewCount = 6

    // The logged-in member, resolved against the loaded member list.
    private var myMember: Member? {
        guard let slug = auth.memberSlug else { return nil }
        return members.first { $0.slug == slug }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack {
                    Text("Show Picker Club")
                        .font(.largeTitle.bold())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Spacer()
                    Button {
                        showingSearch = true
                    } label: {
                        Image(systemName: "magnifyingglass").font(.title3)
                    }
                    .padding(.trailing, 4)
                    accountControl
                }
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 8)

                OfflineBanner()

                List {
                    if let me = myMember {
                        Section {
                            NavigationLink(value: Route.member(me)) {
                                Label("My Shows", systemImage: "person.crop.circle")
                                    .font(.body.weight(.semibold))
                            }
                        }
                    } else if !auth.isLoggedIn {
                        Section {
                            Button {
                                showingLogin = true
                            } label: {
                                Label("Log in to see your shows", systemImage: "person.crop.circle.badge.plus")
                            }
                        }
                    }
                    if auth.isAdmin {
                        Section {
                            NavigationLink {
                                AdminView().environmentObject(auth)
                            } label: {
                                Label("Admin", systemImage: "wrench.and.screwdriver")
                            }
                        }
                    }
                    if !popular.isEmpty {
                        Section("What members are watching") {
                            ForEach(popular) { show in
                                NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                                    popularRow(show)
                                }
                            }
                        }
                    }
                    Section("Members") {
                        let visible = showAllMembers ? members : Array(members.prefix(memberPreviewCount))
                        ForEach(visible) { m in
                            NavigationLink(value: Route.member(m)) {
                                memberRow(m)
                            }
                        }
                        if members.count > memberPreviewCount {
                            Button {
                                withAnimation { showAllMembers.toggle() }
                            } label: {
                                Label(showAllMembers ? "Show fewer" : "Show all \(members.count) members",
                                      systemImage: showAllMembers ? "chevron.up" : "chevron.down")
                                    .font(.callout)
                            }
                        }
                    }
                }
                .listStyle(.insetGrouped)
                .refreshable { await load() }
                .task { if loading { await load() } }
                .overlay { if loading && members.isEmpty { ProgressView() } }
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .member(let m):
                    MemberView(member: m)
                case .detail(let id, let title, let network, let rating):
                    ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
                }
            }
            .sheet(isPresented: $showingLogin) {
                LoginView().environmentObject(auth)
            }
            .sheet(isPresented: $showingSearch) {
                SearchView().environmentObject(auth)
            }
            .sheet(item: $shakePick) { pick in
                ShakePickView(show: pick).environmentObject(auth)
            }
            .onShake { Task { await handleShake() } }
        }
    }

    // Easter egg: a shake surfaces a random show from the logged-in member's
    // own Up Next list. Silent if you're logged out or your Up Next is empty.
    @MainActor
    private func handleShake() async {
        guard let slug = auth.memberSlug, shakePick == nil else { return }
        let mine = (try? await API.shows(member: slug)) ?? []
        let upNext = mine.filter { $0.list == ShowList.next.rawValue && !$0.isArchived }
        if let pick = upNext.randomElement() {
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            shakePick = pick
        }
    }

    // Account control shown on the title line: a menu (Log out) when signed in,
    // otherwise a tap target that opens the login sheet.
    private var accountControl: some View {
        Group {
            if auth.isLoggedIn {
                Menu {
                    Button(role: .destructive) {
                        Task { await auth.logout() }
                    } label: {
                        Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
                    }
                } label: {
                    Image(systemName: "person.crop.circle").font(.title)
                }
            } else {
                Button {
                    showingLogin = true
                } label: {
                    Image(systemName: "person.crop.circle").font(.title)
                }
            }
        }
    }

    private func popularRow(_ s: PopularShow) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.title).font(.body)
                if let n = s.network, !n.isEmpty {
                    Text(n).font(.caption).foregroundStyle(.secondary)
                }
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

    private func memberRow(_ m: Member) -> some View {
        HStack {
            Text(m.label)
            Spacer()
            if m.activeCount > 0 {
                Text("\(m.activeCount) active").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        async let m = try? await API.members()
        async let p = try? await API.popular()
        let mr = (await m) ?? []
        let pr = (await p) ?? []
        // Most active first — Watching + Up Next + Recommending — then most
        // recent activity as a tiebreaker so the preview surfaces live members.
        members = mr.sorted {
            if $0.activeCount != $1.activeCount { return $0.activeCount > $1.activeCount }
            return ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "")
        }
        popular = pr
    }
}

// Nav routes. Hashable for NavigationStack value links.
enum Route: Hashable {
    case member(Member)
    case detail(id: Int, title: String, network: String?, rating: String?)
}
