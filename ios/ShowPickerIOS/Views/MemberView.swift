import SwiftUI

// Mirrors the web sort dropdown: "Next episode" (premiere date, Watching/Waiting
// only), Rating, A–Z, Date Added, plus "My Order" (drag to sort, own lists
// only). Each list remembers its own choice.
private enum SortOption: String, CaseIterable {
    case nextup, rating, alpha, added, manual
    var menuLabel: String {
        switch self {
        case .nextup: return "Sort by Next episode"
        case .rating: return "Sort by Rating"
        case .alpha:  return "Sort A–Z"
        case .added:  return "Sort by Date Added"
        case .manual: return "My Order (drag to sort)"
        }
    }
}

struct MemberView: View {
    let member: Member
    // When set, the view is pinned to a single list (the iPad sidebar exposes
    // each list as its own entry) and the segmented picker is hidden.
    let fixedList: ShowList?
    @EnvironmentObject private var auth: AuthStore
    @State private var shows: [Show] = []
    @State private var currentList: ShowList
    @State private var loading = true
    @State private var showingLogin = false
    @State private var showingAdd = false
    @State private var showingSearch = false
    @State private var editingShow: Show?
    @State private var sortByList: [String: SortOption] = [:]
    // Archive Undo: the just-archived show, shown in a 6-second bottom
    // banner (mirrors the web's undo toast).
    @State private var undoShow: Show?
    @State private var undoDismiss: Task<Void, Never>?

    init(member: Member, fixedList: ShowList? = nil) {
        self.member = member
        self.fixedList = fixedList
        _currentList = State(initialValue: fixedList ?? .watching)
    }

    private var isMine: Bool { auth.isMe(member.slug) }

    var body: some View {
        VStack(spacing: 0) {
            OfflineBanner()

            if fixedList == nil {
                Picker("List", selection: $currentList) {
                    ForEach(ShowList.allCases) { l in Text(l.title).tag(l) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.top, 8)
            }

            // In reorder mode the help line becomes the how-to, so the grab
            // handles never appear unexplained.
            Text(isReordering
                 ? "My Order: press the ≡ handle and drag a show up or down. Your order is saved."
                 : listHelp(currentList))
                .font(.caption)
                .foregroundStyle(isReordering ? Color.accentColor : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.vertical, 6)

            List {
                let items = sortedItems()
                if items.isEmpty {
                    emptyState
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
                                    Task { await archiveWithUndo(show) }
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
                    .onMove(perform: isReordering ? moveItems : nil)
                }

                // Footer: 🎬 legend + per-network counts, mirroring the web
                // member page's list footer.
                if !items.isEmpty, NetworkTally.line(for: items) != nil || NetworkTally.hasFullSeries(items) {
                    Section {
                        VStack(spacing: 2) {
                            if NetworkTally.hasFullSeries(items) {
                                Text("🎬 Series Complete")
                            }
                            if let counts = NetworkTally.line(for: items) {
                                Text(counts)
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowBackground(Color.clear)
                    }
                }

                // Subscription audit is personal, so own-page only. (Vibe and
                // Calendar moved to the home list / iPad sidebar.)
                if isMine {
                    Section {
                        NavigationLink {
                            SubscriptionAuditView()
                        } label: {
                            Label("Subscription audit", systemImage: "creditcard")
                        }
                    }
                }
            }
            // Edit mode is what puts the standard ≡ reorder handles on every
            // row (and it pauses row navigation while dragging, which is the
            // stock reorder behavior). Driven by the sort choice, so picking
            // any other sort drops straight back to normal browsing.
            .environment(\.editMode, .constant(isReordering ? .active : .inactive))
        }
        .navigationTitle(fixedList.map { list in
            isMine ? list.title : "\(member.label) · \(list.title)"
        } ?? "\(member.label)'s Shows")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // Member-scoped search (includes archived — the restore path).
                Button { showingSearch = true } label: { Image(systemName: "magnifyingglass") }
            }
            ToolbarItem(placement: .topBarTrailing) { sortMenu }
            ToolbarItem(placement: .topBarTrailing) {
                if isMine {
                    Button { showingAdd = true } label: { Image(systemName: "plus") }
                } else if auth.isLoggedIn {
                    EmptyView()
                } else {
                    Button("Log in") { showingLogin = true }
                }
            }
        }
        // Archive Undo banner, mirroring the web's 6-second undo toast.
        .overlay(alignment: .bottom) {
            if let s = undoShow {
                HStack(spacing: 12) {
                    Text("Archived “\(s.title)”").lineLimit(1)
                    Spacer()
                    Button("Undo") { undoArchive() }.fontWeight(.bold)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal)
                .padding(.bottom, 8)
                .transition(.move(edge: .bottom).combined(with: .opacity))
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
        // Reload on dismiss: a restore from the search sheet's detail screen
        // should show up in the list immediately.
        .sheet(isPresented: $showingSearch, onDismiss: { Task { await load() } }) {
            MemberSearchView(member: member).environmentObject(auth)
        }
        .sheet(isPresented: $showingAdd) {
            if isMine {
                AddEditShowView(memberSlug: member.slug, existing: nil) { await load() }
            }
        }
        .sheet(item: $editingShow) { show in
            AddEditShowView(memberSlug: member.slug, existing: show) { await load() }
        }
    }

    private var sortMenu: some View {
        Menu {
            Picker("Sort", selection: sortSelection) {
                // "Next episode" is only meaningful where premiere dates apply.
                if currentList == .watching || currentList == .waiting {
                    Text(SortOption.nextup.menuLabel).tag(SortOption.nextup)
                }
                Text(SortOption.rating.menuLabel).tag(SortOption.rating)
                Text(SortOption.alpha.menuLabel).tag(SortOption.alpha)
                Text(SortOption.added.menuLabel).tag(SortOption.added)
                // Dragging rearranges MY rows, so guests don't get the option.
                if isMine {
                    Text(SortOption.manual.menuLabel).tag(SortOption.manual)
                }
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
        case .recommending: return "Shows you've watched and loved."
        case .next:         return "Saved to watch later, plus suggestions from others."
        }
    }

    private func defaultSort(_ list: ShowList) -> SortOption {
        (list == .watching || list == .waiting) ? .nextup : .rating
    }

    private var currentSort: SortOption {
        let saved = sortByList[currentList.rawValue] ?? defaultSort(currentList)
        // Manual sort is meaningless on someone else's page (their order,
        // my saved preference) — fall back to the list's default there.
        if saved == .manual && !isMine { return defaultSort(currentList) }
        return saved
    }

    // Drag-reorder mode: my page, "My Order" selected. Puts the List in edit
    // mode so every row grows the standard ≡ grab handle.
    private var isReordering: Bool { isMine && currentSort == .manual }

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
    // "Next episode", and "Date Added" is newest-first with seed (null-date) rows last.
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
        case .manual:
            // My saved drag order; never-placed rows (nil sort_order — e.g.
            // added after the last drag) sink to the bottom, rating-sorted.
            return base.sorted { a, b in
                let pa = a.sortOrder ?? Int.max
                let pb = b.sortOrder ?? Int.max
                if pa != pb { return pa < pb }
                return (Double(a.rating ?? "0") ?? 0) > (Double(b.rating ?? "0") ?? 0)
            }
        }
    }

    // Drag handler for "My Order": restamp positions locally so the list
    // re-renders in the new order instantly, then persist the whole order.
    private func moveItems(from source: IndexSet, to destination: Int) {
        var items = sortedItems()
        items.move(fromOffsets: source, toOffset: destination)
        let orderedIds = items.map(\.id)
        for (pos, id) in orderedIds.enumerated() {
            if let idx = shows.firstIndex(where: { $0.id == id }) {
                shows[idx].sortOrder = pos
            }
        }
        Task { try? await API.reorderShows(list: currentList.rawValue, ids: orderedIds) }
    }

    // "Next episode: 6/1 · 3 seasons" — premiere range plus the seasons count when
    // both are known; either part alone otherwise. nil if neither exists.
    private func nextUpLine(_ s: Show) -> String? {
        let parts = [s.nextUpRange.map { "Next episode: \($0)" }, s.seasonsText].compactMap { $0 }
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
                // A premiere date shows on EVERY list — a Loved show that
                // drops a surprise season is exactly what to surface.
                if s.nextUpRange != nil, let line = nextUpLine(s) {
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

    // ── Empty states (mirrors the web's EMPTY_COPY: owner gets guidance and
    // an Add CTA on the lists you fill yourself; guests get a neutral line).
    @ViewBuilder private var emptyState: some View {
        VStack(spacing: 8) {
            Text(emptyHeadline)
                .fontWeight(.semibold)
                .multilineTextAlignment(.center)
            if isMine, let help = emptyHelp {
                Text(help)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            if isMine && (currentList == .watching || currentList == .next) {
                Button("Add a show") { showingAdd = true }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
            }
        }
        .padding(.vertical, 24)
    }

    private var emptyHeadline: String {
        if isMine {
            switch currentList {
            case .watching:     return "You're not watching anything yet."
            case .waiting:      return "Nothing awaiting a next season."
            case .recommending: return "Nothing loved yet."
            case .next:         return "Your Next Up is empty."
            }
        }
        switch currentList {
        case .watching:     return "\(member.label) isn't watching anything right now."
        case .waiting:      return "\(member.label) isn't awaiting any seasons."
        case .recommending: return "\(member.label) hasn't loved anything yet."
        case .next:         return "\(member.label)'s Next Up is empty."
        }
    }

    private var emptyHelp: String? {
        switch currentList {
        case .watching:     return "Add a show you're actively watching so the club knows what you're into."
        case .waiting:      return "When you finish a season but want to come back, move the show here. Premiere dates show on your calendar feed."
        case .recommending: return "Once you've watched something you loved, move it here so the rest of the club sees it."
        case .next:         return "Add shows you want to watch later, plus picks from other members."
        }
    }

    // ── Archive with Undo ────────────────────────────────────────────────
    private func archiveWithUndo(_ show: Show) async {
        try? await API.archiveShow(id: show.id)
        await load()
        undoDismiss?.cancel()
        withAnimation { undoShow = show }
        undoDismiss = Task {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !Task.isCancelled {
                withAnimation { undoShow = nil }
            }
        }
    }

    private func undoArchive() {
        guard let s = undoShow else { return }
        undoDismiss?.cancel()
        withAnimation { undoShow = nil }
        Task {
            try? await API.restoreShow(id: s.id, to: s.list)
            await load()
        }
    }
}
