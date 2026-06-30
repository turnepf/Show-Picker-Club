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
                    .foregroundColor(Theme.text)
                    .padding(.top, 20)

                if loading {
                    ProgressView().padding(.top, 80)
                } else if let errorText {
                    Text(errorText).foregroundColor(Theme.muted)
                } else if shows.allSatisfy({ ShowList(rawValue: $0.list) == nil }) {
                    // Defensive empty-state: tvOS focus engine needs *some*
                    // visible content to land on, otherwise the screen looks
                    // hung when every list happens to be empty (e.g. a brand-
                    // new member, or a member whose rows all carry an
                    // unrecognised list value).
                    VStack(spacing: 24) {
                        Text("\(member.label) hasn't added any shows yet.")
                            .font(.system(size: 32))
                            .foregroundColor(Theme.muted)
                            .multilineTextAlignment(.center)
                        Text("Check back later, or pick another member from the home page.")
                            .font(.system(size: 24))
                            .foregroundColor(Theme.muted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 80)
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
        .background(Theme.background.ignoresSafeArea())
        .task { await load() }
    }

    private func shelf(list: ShowList, items: [Show]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Circle().fill(Theme.listColor(list.rawValue)).frame(width: 18, height: 18)
                Text(list.title)
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundColor(Theme.text)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 40) {
                    ForEach(sorted(items, for: list)) { show in
                        NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                            ShowCard(title: show.title,
                                     network: show.network,
                                     rating: show.rating,
                                     fullSeries: show.isFullSeries,
                                     metaLine: show.metaLine(for: list),
                                     posterUrl: show.posterUrl)
                        }
                        .buttonStyle(PushButtonStyle())
                    }
                }
                .padding(.horizontal, 4)
            }
        }
    }

    // Match iOS defaults: Watching/Waiting lead with the soonest premiere,
    // the other lists with the highest rating.
    private func sorted(_ items: [Show], for list: ShowList) -> [Show] {
        if list == .watching || list == .waiting {
            return items.sorted { a, b in
                let da = (a.nextSeasonDate?.isEmpty == false) ? a.nextSeasonDate! : "9999-12-31"
                let db = (b.nextSeasonDate?.isEmpty == false) ? b.nextSeasonDate! : "9999-12-31"
                if da != db { return da < db }
                return (Double(a.rating ?? "0") ?? 0) > (Double(b.rating ?? "0") ?? 0)
            }
        }
        return items.sorted { (Double($0.rating ?? "0") ?? 0) > (Double($1.rating ?? "0") ?? 0) }
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
