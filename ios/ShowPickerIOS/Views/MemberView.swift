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

// Movies / series split for a list that holds both. Sits next to SortOption
// because it's the same kind of per-list, remembered display choice.
enum MediaFilter: String, CaseIterable, Identifiable {
    case all, series, movies
    var id: String { rawValue }

    var title: String {
        switch self {
        case .all: return "All"
        case .series: return "TV"
        case .movies: return "Movies"
        }
    }

    func matches(_ show: Show) -> Bool {
        switch self {
        case .all: return true
        case .series: return !show.isMovie
        case .movies: return show.isMovie
        }
    }

    func count(in shows: [Show]) -> Int {
        shows.filter { matches($0) }.count
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
    @State private var showingImport = false
    @State private var showingSearch = false
    @State private var editingShow: Show?
    // Programmatic push for taps while reordering: edit mode swallows
    // NavigationLink taps, so the row's tap gesture lands here instead.
    @State private var reorderDetail: Show?
    @State private var sortByList: [String: SortOption] = [:]
    // Media filter per list — "what movie can we watch tonight" gets asked at
    // the list, so it's a visible control rather than a menu item. Remembered
    // per list, like sort.
    @State private var mediaFilterByList: [String: MediaFilter] = [:]
    // Liza's genre filter, offered on Next Up alone. Next Up is the list that
    // grows without limit — it's the someday pile — so it's the one where
    // "just show me the comedies" is how you actually pick something. The
    // other three are short enough to read.
    @State private var genreFilter: String?
    // Archive Undo: the just-archived show, shown in a 6-second bottom
    // banner (mirrors the web's undo toast).
    @State private var undoShow: Show?
    @State private var undoDismiss: Task<Void, Never>?
    // A load that threw (vs. a genuinely empty library) — the empty state
    // must not claim "you're not watching anything" when the server failed.
    @State private var loadFailed = false
    // Failed-write banner, same bottom slot as the undo banner.
    @State private var errorBanner: String?
    @State private var errorDismiss: Task<Void, Never>?

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
            // handles never appear unexplained. Viewing someone else's
            // arrangement gets a read-only caption instead.
            Text(isReordering
                 ? "My Order: drag the ≡ handle to sort — tap a show to open it. Your order is saved."
                 : (currentSort == .manual && !isMine
                    ? "Shown in \(member.label)'s own order."
                    : listHelp(currentList)))
                .font(.caption)
                .foregroundStyle(isReordering ? Color.accentColor : Color.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.top, 6)
                .padding(.bottom, 6)

            importPrompt

            List {
                // Nothing admin-only here on purpose. This page shows an
                // operator exactly what the member sees; the operator's view
                // of them is Admin ▸ Manage members ▸ that member.
                let items = sortedItems()
                if items.isEmpty {
                    Group {
                        if loadFailed && shows.isEmpty {
                            loadFailedState
                        } else if currentList == .next, let genreFilter, !listItems().isEmpty {
                            // Say which filter emptied the screen, rather than
                            // letting a full list read as an empty one.
                            Text("Nothing on this list is \(genreFilter).")
                                .foregroundStyle(.secondary)
                        } else if mediaFilter != .all && !listItems().isEmpty {
                            Text(mediaFilter == .movies
                                 ? "No movies on this list."
                                 : "No series on this list.")
                                .foregroundStyle(.secondary)
                        } else {
                            emptyState
                        }
                    }
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(items) { show in
                        NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                            row(show)
                        }
                        // Edit mode disables the NavigationLink tap, but the web
                        // still opens the card in manual sort — so while
                        // reordering, a tap on the row (not the ≡ handle) pushes
                        // the detail programmatically. Masked to .subviews when
                        // NOT reordering so it never competes with — and swallows
                        // — the row's value-based NavigationLink tap (which is
                        // what stopped member-list cards from opening).
                        .simultaneousGesture(
                            TapGesture().onEnded { reorderDetail = show },
                            including: isReordering ? .all : .subviews
                        )
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
                                        Task { await move(show, to: p.target) }
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
                        NavigationLink {
                            RateBacklogView()
                        } label: {
                            Label("Rate my shows", systemImage: "star.fill")
                        }
                    }
                }
            }
            // Edit mode is what puts the standard ≡ reorder handles on every
            // row (and it pauses row navigation while dragging, which is the
            // stock reorder behavior). Driven by the sort choice, so picking
            // any other sort drops straight back to normal browsing.
            .environment(\.editMode, .constant(isReordering ? .active : .inactive))
            // Destination for taps made while reordering (see the row's tap
            // gesture). Pushes the same card as the NavigationLink route.
            .navigationDestination(item: $reorderDetail) { show in
                ShowDetailView(id: show.id, initialTitle: show.title,
                               initialNetwork: show.network, initialRating: show.rating)
            }
        }
        .navigationTitle(fixedList.map { list in
            isMine ? list.title : "\(member.label) · \(list.title)"
        } ?? "\(member.label)'s Shows")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // On your own lists this is Find a Show — the one way to add,
                // and it turns up your archived copies too (the restore path).
                // On someone else's it searches their library.
                Button { showingSearch = true } label: { Image(systemName: "magnifyingglass") }
                    .accessibilityLabel(isMine ? "Find a show to add" : "Search \(member.label)'s shows")
            }
            ToolbarItem(placement: .topBarTrailing) { sortMenu }
            // Own lists only — importing writes to the signed-in member, so
            // it would be a lie on someone else's page. There is no separate
            // "+": adding a show starts from the search above.
            ToolbarItem(placement: .topBarTrailing) {
                if isMine {
                    Button { showingImport = true } label: {
                        Image(systemName: "doc.on.clipboard")
                    }
                    .accessibilityLabel("Paste a list")
                } else if !auth.isLoggedIn {
                    Button("Log in") { showingLogin = true }
                }
            }
        }
        // Bottom banners: failed-write errors and the archive Undo toast
        // (mirroring the web's 6-second undo toast).
        .overlay(alignment: .bottom) {
            VStack(spacing: 8) {
                if let msg = errorBanner {
                    Text(msg)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                if let s = undoShow {
                    HStack(spacing: 12) {
                        Text("Archived “\(s.title)”").lineLimit(1)
                        Spacer()
                        Button("Undo") { undoArchive() }.fontWeight(.bold)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
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
        // Reload on dismiss: a show added, or restored from the search
        // sheet's detail screen, should show up in the list immediately.
        .sheet(isPresented: $showingSearch, onDismiss: { Task { await load() } }) {
            if isMine {
                // Seeded with the list being viewed — searching from Awaiting
                // adds to Awaiting.
                SearchView(initialList: currentList).environmentObject(auth)
            } else {
                MemberSearchView(member: member).environmentObject(auth)
            }
        }
        .sheet(item: $editingShow) { show in
            AddEditShowView(memberSlug: member.slug, existing: show) { await load() }
        }
        .sheet(isPresented: $showingImport) {
            if isMine {
                // Same rule as "+" above: the list being viewed is where an
                // unplaced title lands, so a bare watchlist pasted from Next
                // Up stays a watchlist instead of claiming forty shows are
                // in progress. Headings in the paste still override it.
                ImportListView(defaultList: currentList) { await load() }
            }
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
                // On my page this is drag-to-sort; on someone else's it
                // sorts by THEIR saved arrangement, read-only.
                if isMine {
                    Text(SortOption.manual.menuLabel).tag(SortOption.manual)
                } else {
                    Text("\(member.label)'s Order").tag(SortOption.manual)
                }
            }
            // The TV/Movies split lives up here with the other display
            // choices (moved from a chip row under the help line, 2026-08).
            // Same visibility rule the chips had: only on a list that holds
            // both kinds. Ignored while reordering, like the genre filter.
            if showsMediaFilter {
                Divider()
                Picker("Show", selection: mediaFilterSelection) {
                    ForEach(MediaFilter.allCases) { f in
                        Text("\(f.title) (\(f.count(in: listItems())))").tag(f)
                    }
                }
            }
            if showsGenreFilter {
                Divider()
                Picker("Genre", selection: $genreFilter) {
                    Text("All Genres").tag(String?.none)
                    ForEach(genreOptions, id: \.self) { g in
                        Text(g).tag(String?.some(g))
                    }
                }
            }
        } label: {
            Image(systemName: "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Sort and filter")
    }

    private var mediaFilterSelection: Binding<MediaFilter> {
        Binding(
            get: { mediaFilter },
            set: { mediaFilterByList[currentList.rawValue] = $0 }
        )
    }

    // Everything on the open list, before the media filter — the menu's
    // counts come from this, so switching filters doesn't change the numbers.
    private func listItems() -> [Show] {
        shows.filter { $0.list == currentList.rawValue && !$0.isArchived }
    }

    private var mediaFilter: MediaFilter {
        mediaFilterByList[currentList.rawValue] ?? .all
    }

    // TMDB's top-level genres, movie set and TV set both. The dropdown is
    // filtered to these on purpose: titles carry niche tags as well, and
    // offering every one of them turns a filter into a taxonomy.
    private static let majorGenres: Set<String> = [
        "Action", "Action & Adventure", "Adventure", "Animation", "Comedy",
        "Crime", "Documentary", "Drama", "Family", "Fantasy", "History",
        "Horror", "Kids", "Music", "Mystery", "News", "Reality", "Romance",
        "Sci-Fi & Fantasy", "Science Fiction", "Soap", "Talk", "Thriller",
        "War", "War & Politics", "Western",
    ]

    // Built from the genres actually on the open list, commonest first, so the
    // menu never offers a filter that matches nothing — and never shows a
    // single-title genre above one that covers half the list.
    private var genreOptions: [String] {
        var counts: [String: Int] = [:]
        for show in listItems() {
            for g in show.genreList where Self.majorGenres.contains(g) {
                counts[g, default: 0] += 1
            }
        }
        return counts
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .map(\.key)
    }

    // Next Up only, and only once there's more than one genre to choose
    // between — a dropdown with one option in it is furniture.
    private var showsGenreFilter: Bool {
        currentList == .next && genreOptions.count > 1
    }

    // The filter only earns its menu section on a list that holds both kinds.
    // On Watching, where nearly everything is a series, it stays out of the way.
    private var showsMediaFilter: Bool {
        let items = listItems()
        return items.contains(where: { $0.isMovie }) && items.contains(where: { !$0.isMovie })
    }

    // Short description of what each list is for, shown under the tab picker,
    // with the list's own count on the end the way the web writes it —
    // "(12 shows)" answers "how big is this list" without counting rows.
    private func listHelp(_ list: ShowList) -> String {
        let n = shows.filter { $0.list == list.rawValue && !$0.isArchived }.count
        let suffix = n > 0 ? " (\(n) show\(n == 1 ? "" : "s"))" : ""
        return listBlurb(list) + suffix
    }

    private func listBlurb(_ list: ShowList) -> String {
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
        sortByList[currentList.rawValue] ?? defaultSort(currentList)
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
        var base = isReordering ? listItems() : listItems().filter { mediaFilter.matches($0) }
        // Reordering is a write to the member's own arrangement, so it always
        // acts on the whole list — dragging inside a filtered subset would
        // silently reposition rows against titles you can't see.
        // Scoped to Next Up, the only list that offers the control. Applying
        // it anywhere else would filter a list whose menu can't show — or
        // clear — the filter doing it.
        if !isReordering, currentList == .next, let genreFilter {
            base = base.filter { $0.genreList.contains(genreFilter) }
        }
        switch currentSort {
        case .alpha:
            return base.sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
        case .added:
            return base.sorted { ($0.createdAt ?? "") > ($1.createdAt ?? "") }
        case .nextup:
            return base.sorted(by: Show.byNextPremiere)
        case .rating:
            return base.sorted(by: Show.byRating)
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
        Task {
            do { try await API.reorderShows(list: currentList.rawValue, ids: orderedIds) }
            catch { showError(error, action: "save your order") }
        }
    }

    // Next Up rows name who recommended the show; every other list just shows
    // the network. The premiere/season line comes from ShowRow itself.
    private func rowCaption(_ s: Show) -> String? {
        var parts: [String] = []
        if let n = s.network, !n.isEmpty { parts.append(n) }
        if currentList == .next, let by = s.recommendedBy, !by.isEmpty {
            parts.append("rec'd by \(by)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func row(_ s: Show) -> some View {
        ShowRow(s, caption: rowCaption(s))
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            shows = try await API.shows(member: member.slug)
            loadFailed = false
        } catch {
            // Keep whatever's already on screen — stale beats blank — and
            // let the empty state say "couldn't load", not "empty library".
            loadFailed = true
        }
    }

    // One-tap swipe promotion to another list. Offline moves are queued by
    // the API layer; a real server rejection surfaces in the error banner.
    private func move(_ show: Show, to target: ShowList) async {
        do { try await API.moveShow(id: show.id, to: target.rawValue) }
        catch { showError(error, action: "move “\(show.title)”") }
        await load()
    }

    // Failed-write banner in the undo-toast slot, auto-dismissed after 6s.
    private func showError(_ error: Error, action: String) {
        errorDismiss?.cancel()
        withAnimation { errorBanner = API.failureLine(error, action: action) }
        errorDismiss = Task {
            try? await Task.sleep(nanoseconds: 6_000_000_000)
            if !Task.isCancelled {
                withAnimation { errorBanner = nil }
            }
        }
    }

    // A quiet nudge for a member who has barely started, sitting above the
    // list rather than inside it so it shows on whichever of the four lists
    // they happen to be looking at. The count is across all four lists, not
    // the current one — someone with four shows on Loved isn't new.
    //
    // It retires itself once they're past a handful, so there is no dismiss
    // button and no stored flag: nothing to reset on logout, and nothing that
    // could outlive the session it was shown in.
    @ViewBuilder private var importPrompt: some View {
        if isMine && !isReordering && !shows.isEmpty && shows.count <= 5 {
            Button {
                showingImport = true
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "doc.on.clipboard")
                    Text("Have a list somewhere else? Paste it in.")
                        .font(.subheadline)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal)
                .padding(.vertical, 10)
            }
            .buttonStyle(.plain)
            .background(Color(.secondarySystemBackground))
        }
    }

    @ViewBuilder private var loadFailedState: some View {
        VStack(spacing: 8) {
            Text("Couldn't load \(isMine ? "your" : "\(member.label)'s") shows.")
                .fontWeight(.semibold)
            Text("This is a loading problem, not an empty list — pull down to try again.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
        .padding(.vertical, 24)
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
                Button("Find a show to add") { showingSearch = true }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
            }
            // A member with nothing anywhere is almost always new, and a list
            // they keep somewhere else is the fastest way to a full library.
            // Once they have a few shows this stops being the useful thing to
            // say, so it goes away on its own (see importPrompt).
            if isMine && shows.isEmpty {
                Button("Paste a list from somewhere else") { showingImport = true }
                    .font(.callout)
                    .padding(.top, 2)
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
        let isNot = member.labelIsPlural ? "aren't" : "isn't"
        let hasNot = member.labelIsPlural ? "haven't" : "hasn't"
        switch currentList {
        case .watching:     return "\(member.label) \(isNot) watching anything right now."
        case .waiting:      return "\(member.label) \(isNot) awaiting any seasons."
        case .recommending: return "\(member.label) \(hasNot) loved anything yet."
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
        do { try await API.archiveShow(id: show.id) }
        catch {
            // No undo banner for an archive that didn't happen.
            showError(error, action: "archive “\(show.title)”")
            return
        }
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
            do { try await API.restoreShow(id: s.id, to: s.list) }
            catch { showError(error, action: "restore “\(s.title)”") }
            await load()
        }
    }
}
