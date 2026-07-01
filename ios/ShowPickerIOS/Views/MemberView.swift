import SwiftUI

// Mirrors the web sort dropdown: "Next up" (premiere date, Watching/Waiting
// only), Rating, A–Z, Date Added. Each list remembers its own choice.
private enum SortOption: String, CaseIterable {
    case nextup, rating, alpha, added
    var menuLabel: String {
        switch self {
        case .nextup: return "Sort by Next up"
        case .rating: return "Sort by Rating"
        case .alpha:  return "Sort A–Z"
        case .added:  return "Sort by Date Added"
        }
    }
}

struct MemberView: View {
    let member: Member
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.openURL) private var openURL
    @State private var shows: [Show] = []
    @State private var currentList: ShowList = .watching
    @State private var loading = true
    @State private var showingLogin = false
    @State private var showingAdd = false
    @State private var editingShow: Show?
    @State private var sortByList: [String: SortOption] = [:]

    private var isMine: Bool { auth.isMe(member.slug) }

    var body: some View {
        VStack(spacing: 0) {
            OfflineBanner()

            Picker("List", selection: $currentList) {
                ForEach(ShowList.allCases) { l in Text(l.title).tag(l) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.top, 8)

            Text(listHelp(currentList))
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.vertical, 6)

            List {
                let items = sortedItems()
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
                        // One-tap promotions to the list each row should move to,
                        // colour-coded to the destination. Full swipe fires the first.
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            if isMine {
                                ForEach(listPromotions(for: currentList)) { p in
                                    Button {
                                        Task { try? await API.moveShow(id: show.id, to: p.target.rawValue); await load() }
                                    } label: { Label(p.label, systemImage: p.systemImage) }
                                        .tint(p.tint)
                                }
                            }
                        }
                    }
                }

                // Insights for this member. Vibe is viewable for anyone; the
                // subscription audit is personal, so own-page only.
                Section {
                    NavigationLink {
                        VibeView(initialSlug: member.slug)
                    } label: {
                        Label("Vibe", systemImage: "sparkles")
                    }
                    if isMine {
                        NavigationLink {
                            SubscriptionAuditView()
                        } label: {
                            Label("Subscription audit", systemImage: "creditcard")
                        }
                    }
                }

                // Subscribe to this member's premiere/finale feed. webcal:// makes
                // iOS offer to add it as a subscription calendar.
                Section {
                    Button {
                        let enc = member.slug.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? member.slug
                        if let url = URL(string: "webcal://showpicker.club/calendar/\(enc).ics") {
                            openURL(url)
                        }
                    } label: {
                        Label("Subscribe in Calendar", systemImage: "calendar.badge.plus")
                    }
                } footer: {
                    Text("Adds \(member.label)'s upcoming season premieres and finales to your calendar app.")
                }
            }
        }
        .navigationTitle("\(member.label)'s Shows")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) { sortMenu }
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
        .onAppear {
            loadSavedSorts()
            // Refresh on every reappear (e.g. returning from the show-detail
            // screen after an edit moved a show to another list). `.task` only
            // runs on first appearance, so without this the list stays stale
            // until a pull-to-refresh. No spinner flash: the loading overlay
            // only shows while `shows` is empty.
            if !loading { Task { await load() } }
        }
        .refreshable { await load() }
        .task { if loading { await load() } }
        .overlay { if loading && shows.isEmpty { ProgressView() } }
        .sheet(isPresented: $showingLogin) {
            LoginView().environmentObject(auth)
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

    private var sortMenu: some View {
        Menu {
            Picker("Sort", selection: sortSelection) {
                // "Next up" is only meaningful where premiere dates apply.
                if currentList == .watching || currentList == .waiting {
                    Text(SortOption.nextup.menuLabel).tag(SortOption.nextup)
                }
                Text(SortOption.rating.menuLabel).tag(SortOption.rating)
                Text(SortOption.alpha.menuLabel).tag(SortOption.alpha)
                Text(SortOption.added.menuLabel).tag(SortOption.added)
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
        }
    }

    // Short description of what each list is for, shown under the tab picker.
    private func listHelp(_ list: ShowList) -> String {
        switch list {
        case .watching:     return "Shows you're actively watching."
        case .waiting:      return "Between seasons — premiere dates show on the calendar feed."
        case .recommending: return "Shows worth recommending to the club."
        case .next:         return "Saved to watch later, plus suggestions from others."
        }
    }

    private func defaultSort(_ list: ShowList) -> SortOption {
        (list == .watching || list == .waiting) ? .nextup : .rating
    }

    private var currentSort: SortOption {
        sortByList[currentList.rawValue] ?? defaultSort(currentList)
    }

    private var sortSelection: Binding<SortOption> {
        Binding(
            get: { currentSort },
            set: { newValue in
                sortByList[currentList.rawValue] = newValue
                UserDefaults.standard.set(newValue.rawValue, forKey: "sort_order_\(currentList.rawValue)")
            }
        )
    }

    private func loadSavedSorts() {
        for l in ShowList.allCases {
            if let raw = UserDefaults.standard.string(forKey: "sort_order_\(l.rawValue)"),
               let s = SortOption(rawValue: raw) {
                sortByList[l.rawValue] = s
            }
        }
    }

    // Same ordering rules as the web: undated shows sink to the bottom on
    // "Next up", and "Date Added" is newest-first with seed (null-date) rows last.
    private func sortedItems() -> [Show] {
        let base = shows.filter { $0.list == currentList.rawValue && !$0.isArchived }
        switch currentSort {
        case .alpha:
            return base.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .added:
            return base.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
        case .nextup:
            return base.sorted { a, b in
                let da = (a.nextSeasonDate?.isEmpty == false) ? a.nextSeasonDate! : "9999-12-31"
                let db = (b.nextSeasonDate?.isEmpty == false) ? b.nextSeasonDate! : "9999-12-31"
                if da != db { return da < db }
                return (Double(a.rating ?? "0") ?? 0) > (Double(b.rating ?? "0") ?? 0)
            }
        case .rating:
            return base.sorted { (Double($0.rating ?? "0") ?? 0) > (Double($1.rating ?? "0") ?? 0) }
        }
    }

    // "Next up: 6/1 · 3 seasons" — premiere range plus the seasons count when
    // both are known; either part alone otherwise. nil if neither exists.
    private func nextUpLine(_ s: Show) -> String? {
        let parts = [s.nextUpRange.map { "Next up: \($0)" }, s.seasonsText].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private func row(_ s: Show) -> some View {
        HStack(spacing: 12) {
            PosterThumb(url: s.posterUrl)
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
                if (currentList == .watching || currentList == .waiting),
                   let line = nextUpLine(s) {
                    Label(line, systemImage: "calendar")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .labelStyle(.titleAndIcon)
                } else if let seasons = s.seasonsText {
                    Text(seasons)
                        .font(.caption)
                        .foregroundStyle(.secondary)
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

    private func load() async {
        loading = true
        defer { loading = false }
        shows = (try? await API.shows(member: member.slug)) ?? []
    }
}
