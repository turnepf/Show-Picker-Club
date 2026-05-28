import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var auth: AuthStore
    @State private var members: [Member] = []
    @State private var popular: [PopularShow] = []
    @State private var loading = true

    var body: some View {
        NavigationStack {
            List {
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
                    ForEach(members) { m in
                        NavigationLink(value: Route.member(m)) {
                            memberRow(m)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Show Picker Club")
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .member(let m):
                    MemberView(member: m)
                case .detail(let id, let title, let network, let rating):
                    ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
                }
            }
            .refreshable { await load() }
            .task { if loading { await load() } }
            .overlay { if loading && members.isEmpty { ProgressView() } }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    if let slug = auth.memberSlug,
                       let me = members.first(where: { $0.slug == slug }) {
                        NavigationLink(value: Route.member(me)) {
                            Label("My Shows", systemImage: "person.crop.circle")
                        }
                    }
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
            if let c = m.watchingCount {
                Text("\(c) watching").font(.caption).foregroundStyle(.secondary)
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
        // Top 6 by watching count, tiebreak on waiting count.
        members = mr.sorted {
            let a = ($0.watchingCount ?? 0, $0.waitingCount ?? 0)
            let b = ($1.watchingCount ?? 0, $1.waitingCount ?? 0)
            return a > b
        }
        popular = pr
    }
}

// Nav routes. Hashable for NavigationStack value links.
enum Route: Hashable {
    case member(Member)
    case detail(id: Int, title: String, network: String?, rating: String?)
}
