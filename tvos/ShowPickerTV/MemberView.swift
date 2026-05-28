import SwiftUI

struct MemberView: View {
    let member: Member
    @State private var shows: [Show] = []
    @State private var loading = true
    @State private var errorText: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 50) {
                Text("\(member.label)'s Shows")
                    .font(.system(size: 48, weight: .bold))
                    .foregroundColor(Theme.ink)
                    .padding(.top, 20)

                if loading {
                    ProgressView().padding(.top, 80)
                } else if let errorText {
                    Text(errorText).foregroundColor(.secondary)
                } else {
                    ForEach(ShowList.allCases) { list in
                        let items = shows.filter { $0.list == list.rawValue }
                        if !items.isEmpty {
                            shelf(list: list, items: items)
                        }
                    }
                }
            }
            .padding(.horizontal, 60)
            .padding(.bottom, 60)
        }
        .background(Theme.cream.ignoresSafeArea())
        .task { await load() }
    }

    private func shelf(list: ShowList, items: [Show]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Circle().fill(Theme.listColor(list.rawValue)).frame(width: 18, height: 18)
                Text(list.title)
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundColor(Theme.ink)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 40) {
                    ForEach(items.sorted { (Double($0.rating ?? "0") ?? 0) > (Double($1.rating ?? "0") ?? 0) }) { show in
                        NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                            ShowCard(title: show.title,
                                     network: show.network,
                                     rating: show.rating,
                                     badge: show.isFullSeries ? "🎬" : nil)
                        }
                        .buttonStyle(.card)
                    }
                }
                .padding(.horizontal, 4)
            }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            shows = try await API.shows(member: member.slug)
        } catch {
            errorText = "Couldn't load \(member.label)'s shows."
        }
    }
}
