import SwiftUI

struct MemberView: View {
    let member: Member
    @EnvironmentObject private var auth: AuthStore
    @State private var shows: [Show] = []
    @State private var picks: [Pick] = []
    @State private var pickMessage: String?
    @State private var loading = true
    @State private var didInitialLoad = false
    @State private var errorText: String?

    private var isMine: Bool { auth.memberSlug == member.slug }

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
                } else {
                    if isMine, !picks.isEmpty { picksShelf }

                    let hasLists = !shows.allSatisfy { ShowList(rawValue: $0.list) == nil }
                    if hasLists {
                        ForEach(ShowList.allCases) { list in
                            let items = shows.filter { $0.list == list.rawValue }
                            if !items.isEmpty {
                                shelf(list: list, items: items)
                            }
                        }
                    } else if !(isMine && !picks.isEmpty) {
                        // Defensive empty-state: the tvOS focus engine needs some
                        // visible content to land on, otherwise the screen looks
                        // hung when every list is empty.
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
                    }
                }
            }
            .padding(.horizontal, 60)
            .padding(.bottom, 60)
        }
        .background(Theme.background.ignoresSafeArea())
        // First appearance: full load (with the spinner).
        .task { if !didInitialLoad { await load(); didInitialLoad = true } }
        // Returning here (e.g. after archiving / moving a show from its detail):
        // refresh quietly — no `loading` toggle, so the scroll position holds
        // and the lists reflect the change instead of showing stale data.
        .onAppear {
            guard didInitialLoad else { return }
            Task {
                if let s = try? await API.shows(member: member.slug) { shows = s }
                await loadPicks()
            }
        }
    }

    // "Picks for you" — recommendations on your own page; tapping adds to Up Next.
    private var picksShelf: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Image(systemName: "sparkles").foregroundColor(Theme.orange)
                Text("Picks for you")
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundColor(Theme.text)
            }
            if let pickMessage {
                Text(pickMessage)
                    .font(.system(size: 22))
                    .foregroundColor(Theme.muted)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 40) {
                    ForEach(picks) { pick in
                        Button { Task { await addPick(pick) } } label: {
                            ShowCard(title: pick.title, subtitle: pick.reason, posterUrl: pick.posterUrl)
                        }
                        .buttonStyle(PushButtonStyle())
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 30)
            }
        }
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
                                     nextUp: (list == .watching || list == .waiting) ? show.nextUpRange : nil,
                                     networkLogoUrl: show.networkLogoUrl,
                                     posterUrl: show.posterUrl)
                        }
                        .buttonStyle(PushButtonStyle())
                    }
                }
                // Room so a focused card can grow without the ScrollView
                // clipping it ("growing behind a wall").
                .padding(.horizontal, 14)
                .padding(.vertical, 30)
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

    private func addPick(_ pick: Pick) async {
        picks.removeAll { $0.id == pick.id }   // optimistic
        do {
            try await API.addShow(title: pick.title, network: pick.network, networkUrl: pick.networkUrl,
                                  list: ShowList.next.rawValue, movie: false, fullSeries: false)
            pickMessage = "Added “\(pick.title)” to your Up Next."
            // Refresh quietly (no loading spinner, which would reset scroll).
            shows = (try? await API.shows(member: member.slug)) ?? shows
            await loadPicks()
        } catch API.APIError.badResponse(409) {
            pickMessage = "“\(pick.title)” is already on one of your lists."
        } catch {
            pickMessage = "Couldn't add it. Please try again."
            await loadPicks()   // restore on real failure
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
        await loadPicks()
    }

    private func loadPicks() async {
        guard isMine else { picks = []; return }
        if let r = try? await API.recommendations(member: member.slug), r.isSeedOnly != true {
            picks = Array(r.picks.prefix(8))
        } else {
            picks = []
        }
    }
}
