import SwiftUI
// Imported by name (not just via CoreImports' re-export) because this file
// spells the model `ShowPickerCore.Group` — SwiftUI's own `Group` claims the
// bare name. Same reason GroupsListView and GroupDetailView import it.
import ShowPickerCore

struct ShowDetailView: View {
    let id: Int?
    let initialTitle: String
    let initialNetwork: String?
    let initialRating: String?
    var initialPoster: String? = nil
    var initialNetworkUrl: String? = nil

    @EnvironmentObject private var auth: AuthStore
    @State private var show: Show?
    // My own copy of this title (active or archived), resolved on load so the
    // actions and the List row reflect MY row — not the copy that search may
    // have opened by id.
    @State private var myCopy: Show?
    @State private var cast: [Actor] = []
    @State private var showingEdit = false
    @State private var addingToMine = false
    @State private var addAlert: AddAlert?
    // Average/count always present once the show has a tmdb_id; `mine`/
    // `owner` depend on the session — see RatingsSummary.
    @State private var ratings: RatingsSummary?
    // Fellow group members with this title on their Watching list. Empty
    // unless I'm in a group with someone who's watching it.
    @State private var groupWatchers: [GroupWatcher] = []
    // My groups, for "Recommend to group" — the button only renders once
    // there's a group to recommend to.
    @State private var myGroups: [ShowPickerCore.Group] = []
    @State private var choosingRecommendGroup = false
    // The group picked for a recommendation; non-nil drives the note alert.
    @State private var recommendGroup: ShowPickerCore.Group?
    @State private var recommendNote = ""
    @State private var recommending = false
    // Creators resolved to individual people by the server (up to four).
    @State private var creators: [Credit] = []

    private var title: String { show?.title ?? initialTitle }
    private var network: String? { show?.network ?? initialNetwork }
    private var rating: String? { show?.rating ?? initialRating }
    // My active copy of this title, if it's on one of my lists.
    private var mineActive: Show? {
        guard let m = myCopy, !m.isArchived else { return nil }
        return m
    }
    // My archived copy of this title, if I've shelved it.
    private var mineArchived: Show? {
        guard let m = myCopy, m.isArchived else { return nil }
        return m
    }

    var body: some View {
        Form {
            // One hero image (backdrop preferred, else poster). No tap-to-
            // enlarge — the affordance confused people.
            if let b = show?.backdropUrl, !b.isEmpty, URL(string: b) != nil {
                Section {
                    CachedImage(url: b, contentMode: .fit) {
                        Color(.secondarySystemBackground)
                    }
                    // Keep the backdrop's natural 16:9 shape so it fills the
                    // width without cropping. A fixed short height + scaledToFill
                    // chopped the image badly on wide iPad / Mac windows.
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    .frame(maxWidth: .infinity)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
            } else if let p = (show?.posterUrl ?? initialPoster), !p.isEmpty {
                Section {
                    PosterThumb(url: p, width: 130, height: 195)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowBackground(Color.clear)
                }
            }

            // Tagline then overview, right under the title/image with no
            // section header. The tagline leads because it's the one line of
            // copy written to make you want the thing — it reads as a pull
            // quote above the synopsis, not as another fact. Italic and tinted
            // so it's never mistaken for the first sentence of the plot.
            if hasBlurb {
                Section {
                    if let tl = show?.tagline, !tl.isEmpty {
                        Text(tl)
                            .font(.callout.italic())
                            .foregroundStyle(.tertiary)
                    }
                    if let ov = show?.overview, !ov.isEmpty {
                        Text(ov).font(.callout).foregroundStyle(.secondary)
                    }
                }
            }

            // Who else is watching (group members), then where to watch +
            // trailer. The group line sits directly above Network so the
            // social context reads before the "go watch it" affordance.
            if hasWatchRow {
                Section {
                    if !groupWatchers.isEmpty {
                        LabeledContent("Also watching", value: groupWatchersLine)
                    }
                    if let n = network, !n.isEmpty {
                        // The service name alone, so this row and the "Also on"
                        // / "Now on" row below it read in parallel: relationship
                        // on the left, service on the right. It used to read
                        // "Watch on MGM+" to make the affordance obvious — the
                        // tinted link colour is carrying that now.
                        if let urlStr = show?.networkUrl ?? initialNetworkUrl,
                           isRealUrl(urlStr), let url = URL(string: urlStr) {
                            LabeledContent("Network") {
                                Link(n, destination: url)
                            }
                        } else if let wl = show?.whereToWatchURL {
                            // No deep link for this service, only the
                            // aggregator page. The label stays "Network" like
                            // the other two states and the service keeps its
                            // place in the value — it used to trade places
                            // with the label, so this one row read backwards.
                            //
                            // The link text says where it goes rather than
                            // naming the service: tapping it lands on TMDB's
                            // watch page, and a link that reads "MGM+" and
                            // opens something else is the same broken promise
                            // the Amazon URL rule exists to prevent.
                            LabeledContent("Network") {
                                HStack(spacing: 6) {
                                    Text(n)
                                    Text("·").foregroundStyle(.secondary)
                                    Link("Where to watch", destination: wl)
                                }
                            }
                        } else {
                            LabeledContent("Network", value: n)
                        }
                    } else if let wl = show?.whereToWatchURL {
                        // No service to name — a title enriched before the
                        // storefront fallback existed, or one TMDB knows no
                        // US provider for. The aggregator link still answers
                        // the question this row is for.
                        LabeledContent("Network") {
                            Link("Where to watch", destination: wl)
                        }
                    }
                    // Where it streams today, when that differs from the row's
                    // own network. The network above is the member's record and
                    // is never overwritten, so it drifts as licensing moves —
                    // this states the current answer without correcting theirs.
                    //
                    // The label is "Also on" or "Now on" rather than a fixed
                    // "Streaming", so the relationship reads on the left and
                    // the service on the right, in parallel with Network. The
                    // two are not interchangeable: "Also on" means the member's
                    // own service still carries it, "Now on" means it doesn't.
                    //
                    // No link. TMDB names providers but gives no per-provider
                    // deep link, only the aggregator page — which is already
                    // the "Where to watch" affordance on the row above when
                    // that row has nothing better. A tappable "Apple TV+" that
                    // opened TMDB would be the promise this card keeps
                    // refusing to make.
                    //
                    // Silent when TMDB names nothing or was never asked; see
                    // Show.streamingNote.
                    if let row = show?.streamingRow {
                        LabeledContent(row.label, value: row.services)
                    }
                    // Free and free-with-ads services (Tubi, Pluto TV…). No
                    // link, for the same reason as the row above.
                    if let free = show?.freeOnText {
                        LabeledContent("Free on", value: free)
                    }
                    // The title's IMDb page. Absent until enrichment has
                    // stored the id — no row rather than a search fallback.
                    if let iurl = show?.imdbURL {
                        LabeledContent("IMDb") { Link("View on IMDb", destination: iurl) }
                    }
                    if let turl = show?.trailerURL {
                        LabeledContent("Trailer") { Link("▶ Watch trailer", destination: turl) }
                    }
                }
            }

            // Cast as its own block, with the creator/director grouped under it.
            if !cast.isEmpty || hasDirector {
                Section("Cast") {
                    if !cast.isEmpty {
                        Text(castLine).font(.callout).foregroundStyle(.secondary)
                    }
                    if let s = show, let d = s.director, !d.isEmpty {
                        // Each creator links on its own. A co-created show
                        // used to link none of them: one stored id belongs to
                        // the first credit, so linking the joined string would
                        // have pointed everyone at one person.
                        if !creators.isEmpty {
                            LabeledContent(s.directorLabel) { creatorLine }
                        } else if let url = s.directorURL {
                            LabeledContent(s.directorLabel) { Link(d, destination: url) }
                        } else {
                            LabeledContent(s.directorLabel, value: d)
                        }
                    }
                }
            }

            // My Lists — the four list chips ARE the move/add control (tap to
            // move an active copy, restore an archived one, or add it if I don't
            // have it). The member-edited fields and Edit/Archive live here too.
            // Logged-in members only.
            if auth.memberSlug != nil {
                Section("My Lists") {
                    listChipsRow()
                    if mineArchived != nil {
                        Text("Archived — tap a list to add it back")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if let by = myCopy?.recommendedBy, !by.isEmpty {
                        LabeledContent("Recommended by", value: by)
                    }
                    if let w = myCopy?.watchingWith, !w.isEmpty {
                        LabeledContent("Watching with", value: w)
                    }
                    // Why a title you never added is on your list: the
                    // group-mate whose Watching With tag put it there.
                    // Owner-only and nil on your own adds, so it renders
                    // exactly when there's something to explain.
                    if let tagger = myCopy?.addedByMember {
                        LabeledContent("Added by", value: tagger.name)
                    }
                    if let notes = myCopy?.notes, !notes.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Notes").font(.caption).foregroundStyle(.secondary)
                            Text(notes).font(.callout).foregroundStyle(.secondary)
                        }
                    }
                    if let m = mineActive {
                        Button("Edit") { showingEdit = true }
                        // JC's button: put this show on a group's Watch Next
                        // board. It recommends MY copy — that's also the
                        // enrichment source every group-mate's "Add to Next
                        // Up" clones — so it renders only when the title is
                        // on one of my lists and I have a group to tell.
                        if !myGroups.isEmpty {
                            Button {
                                if myGroups.count == 1 {
                                    startRecommend(to: myGroups[0])
                                } else {
                                    choosingRecommendGroup = true
                                }
                            } label: {
                                Label("Recommend to group", systemImage: "megaphone")
                            }
                            .disabled(recommending)
                        }
                        Button(role: .destructive) {
                            Task { await archive(m.id) }
                        } label: {
                            Label("Archive", systemImage: "archivebox")
                        }
                        .disabled(addingToMine)
                    }
                }
            }

            // Ratings — directly below My Lists. TMDB Rating and Club Rating
            // show on every card, logged in or not (ratings key off tmdb_id,
            // not this row's id, so they're the same regardless of whose
            // copy this is). Entry (instant-save tap row) is gated to lists
            // other than Next Up, matching the backend's own gating in
            // PUT /api/shows/:id/rating. Nothing renders until the show has
            // a tmdb_id (ratings is nil until then).
            if let ratings {
                Section("Ratings") {
                    if let r = rating, !r.isEmpty {
                        LabeledContent("TMDB Rating") {
                            Text("\(Image(systemName: "star.fill")) \(r)").foregroundStyle(.orange)
                        }
                    }
                    LabeledContent("Show Picker Club Rating", value: clubRatingText)
                    if let owner = ratings.owner {
                        LabeledContent(ownerRatingLabel, value: "\(owner)/10")
                    }
                    if ratingEligible {
                        RatingEntryRow(label: yourRatingLabel, value: ratings.mine) { value in
                            Task { await rate(value, season: nil) }
                        }
                        ForEach(seasonNumbers, id: \.self) { s in
                            RatingEntryRow(label: seasonLabel(s), value: ratings.mineSeasons[s]) { value in
                                Task { await rate(value, season: s) }
                            }
                        }
                    } else if myCopy?.list == ShowList.next.rawValue {
                        LabeledContent("Your rating", value: "Start watching to rate")
                    } else {
                        // Can't rate here (logged out, or this is someone
                        // else's copy) — the club's season averages are still
                        // worth reading, which is what the web shows.
                        ForEach(seasonNumbers, id: \.self) { s in
                            if let summary = ratings.seasons[s], let avg = summary.average {
                                // Plain label here: seasonLabel() folds the
                                // average into the label for the entry rows,
                                // which would say it twice in this branch.
                                LabeledContent("Season \(s)",
                                               value: String(format: "%.1f/10 (%d)", avg, summary.count))
                            }
                        }
                    }
                }
            }

            // Catalog facts about the show itself, grouped below.
            if hasCatalog {
                Section {
                    if let s = show {
                        if s.isMovie { LabeledContent("Type", value: "Movie") }
                        if let y = s.releaseYear {
                            LabeledContent("Year", value: String(y))
                        }
                        if let series = s.seriesText { LabeledContent("Series", value: series) }
                        if let status = s.statusText { LabeledContent("Status", value: status) }
                        if !s.genreList.isEmpty {
                            LabeledContent("Genres", value: s.genreList.joined(separator: " · "))
                        }
                        if let rt = s.runtimeText {
                            LabeledContent("Runtime", value: rt)
                        }
                        if let dates = s.seasonDatesText {
                            LabeledContent("Next episode", value: dates)
                        }
                        if let cr = s.contentRating, !cr.isEmpty {
                            LabeledContent("Rated", value: cr)
                        }
                        // Only ever non-nil for non-English titles — see
                        // Show.originalLanguageText.
                        if let lang = s.originalLanguageText {
                            LabeledContent("Language", value: lang)
                        }
                    }
                }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.large)
        .toolbar {
            // Standard iOS share sheet — text, mail, AirDrop, anything the
            // user has. Shares a watch link (or the club page) plus a blurb.
            //
            // `preview` names the show in the share sheet itself. The card the
            // *recipient* sees is built somewhere else entirely: their device
            // fetches shareURL and reads the Open Graph tags served by
            // functions/show/[id].js. Nothing set here can change that bubble,
            // which is why every share used to look identical no matter what
            // this subject said.
            ToolbarItem(placement: .topBarTrailing) {
                ShareLink(item: shareURL,
                          subject: Text(shareTitle),
                          message: Text(shareText),
                          preview: SharePreview(shareTitle)) {
                    Image(systemName: "square.and.arrow.up")
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $showingEdit) {
            if let m = myCopy {
                AddEditShowView(memberSlug: m.memberSlug ?? (auth.memberSlug ?? ""), existing: m) { await load() }
            }
        }
        .alert(addAlert?.title ?? "",
               isPresented: Binding(get: { addAlert != nil }, set: { if !$0 { addAlert = nil } }),
               presenting: addAlert) { _ in
            Button("OK", role: .cancel) { }
        } message: { Text($0.message) }
        .confirmationDialog("Recommend to which group?",
                            isPresented: $choosingRecommendGroup,
                            titleVisibility: .visible) {
            ForEach(myGroups) { g in
                Button(g.name) { startRecommend(to: g) }
            }
            Button("Cancel", role: .cancel) { }
        }
        // Note entry rides the same alert-with-TextField shape as the group
        // rename. The note is group-visible by design — it's addressed to
        // the group, unlike the owner-only Notes field on this row.
        .alert("Recommend to \(recommendGroup?.name ?? "group")",
               isPresented: Binding(get: { recommendGroup != nil }, set: { if !$0 { recommendGroup = nil } }),
               presenting: recommendGroup) { g in
            TextField("Add a note (optional)", text: $recommendNote)
            Button("Recommend") { Task { await recommend(to: g) } }
            Button("Cancel", role: .cancel) { }
        } message: { g in
            Text("Everyone in \(g.name) gets a pop-up with Dismiss or Add to Next Up. The note is visible to the whole group.")
        }
    }

    // Whether the "where to watch" section has anything to show.
    private var hasWatchRow: Bool {
        (network.map { !$0.isEmpty } ?? false) || show?.trailerURL != nil
            || !groupWatchers.isEmpty || show?.whereToWatchURL != nil
            || show?.imdbURL != nil || show?.freeOnText != nil
    }

    // "Alex, Dana" — first names only, which is all the endpoint sends.
    private var groupWatchersLine: String {
        groupWatchers.map(\.name).joined(separator: ", ")
    }
    private var hasDirector: Bool { (show?.director.map { !$0.isEmpty }) ?? false }

    // "Dan Erickson, Ben Stiller" with each name its own link when we know
    // their IMDB id, plain text when we don't.
    private var creatorLine: Text {
        creators.reduce(Text("")) { line, credit in
            let sep = line == Text("") ? Text("") : Text(", ")
            var name = AttributedString(credit.name)
            if let url = credit.url {
                name.link = url
                name.underlineStyle = .single
            }
            return line + sep + Text(name)
        }
    }
    private var hasCatalog: Bool {
        // TMDB Rating moved into the Ratings section above — no longer
        // part of what makes this catalog card worth showing.
        guard let s = show else { return false }
        return s.isMovie || s.seriesText != nil || !s.genreList.isEmpty
            || s.seasonDatesText != nil || (s.contentRating.map { !$0.isEmpty } ?? false)
            || s.releaseYear != nil || s.runtimeText != nil
            || s.originalLanguageText != nil || s.statusText != nil
    }

    // Whether the tagline/overview block has anything in it. Either alone is
    // enough — a title can have a tagline and no synopsis, or the reverse.
    private var hasBlurb: Bool {
        guard let s = show else { return false }
        return (s.tagline.map { !$0.isEmpty } ?? false)
            || (s.overview.map { !$0.isEmpty } ?? false)
    }

    // Eligible to enter a rating: I have this show on one of my own lists,
    // and it's not Next Up (not watched yet) — matching the backend's own
    // gating in PUT /api/shows/:id/rating.
    private var ratingEligible: Bool {
        guard let m = mineActive else { return false }
        return m.list != ShowList.next.rawValue
    }

    private var clubRatingText: String {
        guard let avg = ratings?.average else { return "No ratings yet" }
        let count = ratings?.count ?? 0
        return String(format: "%.1f/10 (%d rating%@)", avg, count, count == 1 ? "" : "s")
    }

    private var ownerRatingLabel: String {
        "\(ratings?.ownerName ?? "")'s rating"
    }

    private var yourRatingLabel: String {
        if let mine = ratings?.mine { return "Your rating — \(mine)/10" }
        return "Your rating"
    }

    // Season numbers to show entry rows for — TV only, and only once
    // seasons_released is known.
    private var seasonNumbers: [Int] {
        guard let show, !show.isMovie, let n = show.seasonsReleased, n > 0 else { return [] }
        return Array(1...n)
    }

    private func seasonLabel(_ s: Int) -> String {
        var label = "Season \(s)"
        if let avg = ratings?.seasons[s]?.average {
            label += String(format: " · avg %.1f/10 (%d)", avg, ratings?.seasons[s]?.count ?? 0)
        }
        if let mine = ratings?.mineSeasons[s] {
            label += " — \(mine)/10"
        }
        return label
    }

    // The four list chips, current one filled. Tapping a chip moves/adds/
    // restores the show to that list.
    @ViewBuilder private func listChipsRow() -> some View {
        let cur = mineActive.flatMap { ShowList(rawValue: $0.list) }
        HStack(spacing: 6) {
            ForEach(ShowList.allCases) { l in
                Button { Task { await chipTap(l) } } label: {
                    chipLabel(l, selected: cur == l)
                }
                .buttonStyle(.borderless)
                .disabled(addingToMine)
            }
        }
        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
    }

    private func chipLabel(_ l: ShowList, selected: Bool) -> some View {
        Text(l.title)
            .font(.caption).fontWeight(.semibold)
            .lineLimit(1).minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 7)
            .background(selected ? listColor(l) : Color.clear)
            .foregroundStyle(selected ? Color.white : listColor(l))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(listColor(l), lineWidth: 1.5))
            .clipShape(RoundedRectangle(cornerRadius: 7))
    }

    private func chipTap(_ list: ShowList) async {
        if let m = mineActive {
            if m.list == list.rawValue { return }
            await move(to: list, id: m.id)
        } else if let m = mineArchived {
            await restore(to: list, id: m.id)
        } else {
            await addToMyList(list)
        }
    }

    // Per-list colors, matching the tvOS/web palette.
    private func listColor(_ l: ShowList) -> Color {
        switch l {
        case .watching:    return Color(red: 0.20, green: 0.78, blue: 0.45)
        case .waiting:     return Color(red: 0.26, green: 0.60, blue: 0.90)
        case .recommending: return Color(red: 0.66, green: 0.40, blue: 0.85)
        case .next:        return .orange
        }
    }

    // What the share sheet hands off. Prefer a real deep link so the
    // recipient lands on the show itself; otherwise fall back to the
    // owner's club page so the link still goes somewhere useful.
    // Always a Show Picker link, never the streaming service's. Sharing the
    // network URL sent people straight out of the club to Netflix; /show/<id>
    // opens this same card — in the app for anyone who has it (the AASA
    // claims the path), on the web for everyone else. The title rides along
    // so the card has something to draw before its own fetch lands.
    private var shareURL: URL {
        let id = show?.id ?? self.id
        if let id {
            var comps = URLComponents(string: "https://showpicker.club/show/\(id)")
            comps?.queryItems = [URLQueryItem(name: "title", value: title)]
            if let url = comps?.url { return url }
        }
        // No id yet (a Trending pick that isn't a row) — the member's page is
        // the nearest thing that still lands inside Show Picker.
        let slug = show?.memberSlug ?? ""
        return URL(string: "https://showpicker.club/\(slug)")
            ?? URL(string: "https://showpicker.club")!
    }

    // Matches the og:title functions/show/[id].js serves for the same link, so
    // the share sheet and the recipient's card say the same thing.
    private var shareTitle: String { "\(title) on Show Picker Club" }

    private var shareText: String {
        let place = (network.map { " on \($0)" }) ?? ""
        return "Check out \(title)\(place) — from Show Picker Club"
    }

    // Inline comma list with tappable IMDB links — matches the web's cast
    // card, which lists everyone the row stores (the enrichment caps the
    // cast itself, so there's nothing to trim here). Actors without an IMDB
    // id (legacy rows the enrich backfill hasn't reached yet) stay plain text.
    private var castLine: AttributedString {
        var line = AttributedString()
        for (i, actor) in cast.enumerated() {
            if i > 0 { line += AttributedString(", ") }
            var name = AttributedString(actor.name)
            if let imdb = actor.imdbId, !imdb.isEmpty,
               let url = URL(string: "https://www.imdb.com/name/\(imdb)/") {
                name.link = url
                name.underlineStyle = .single
            }
            line += name
            // The role, outside the link, once enrichment has stored it.
            if let role = actor.character, !role.isEmpty {
                line += AttributedString(" (\(role))")
            }
        }
        return line
    }

    private func isRealUrl(_ u: String) -> Bool {
        let l = u.lowercased()
        if l.isEmpty || l == "#" { return false }
        return !(l.contains("/search") || l.contains("/s?") || l.contains("?q=") || l.contains("?query="))
    }

    private func load() async {
        if let id {
            if let r = try? await API.showDetail(id: id) {
                show = r.show
                ratings = r.ratings
                groupWatchers = r.groupWatchers ?? []
                creators = r.creators ?? []
            }
            cast = (try? await API.actors(showId: id)) ?? []
        }
        await refreshMyCopy()
        // Non-fatally: no groups just means no Recommend button.
        if auth.memberSlug != nil {
            myGroups = (try? await API.groups())?.groups ?? []
        }
    }

    private func startRecommend(to group: ShowPickerCore.Group) {
        recommendNote = ""
        recommendGroup = group
    }

    // Put my copy on the group's board. Nothing lands on anyone's list here —
    // each group-mate's own tap does that, on their own list.
    private func recommend(to group: ShowPickerCore.Group) async {
        guard let m = mineActive, !recommending else { return }
        recommending = true
        defer { recommending = false }
        let note = recommendNote.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            _ = try await API.recommendToGroup(groupId: group.id, showId: m.id,
                                               note: note.isEmpty ? nil : note)
            addAlert = AddAlert(title: "Recommended",
                                message: "“\(title)” is on \(group.name)’s Watch Next board — everyone gets asked about it next time they visit the group.")
        } catch let e as API.APIError where e.status == 429 {
            addAlert = AddAlert(title: "That’s a lot of recommendations",
                                message: "You’ve hit today’s limit for this group — try again tomorrow.")
        } catch let e as API.APIError where e.status == 401 {
            addAlert = AddAlert(title: "Logged out",
                                message: "Your session expired — sign in again from Home.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t recommend",
                                message: "Something went wrong. Please try again.")
        }
    }

    // Find my own row for this title (active or archived) so the actions and
    // the List row reflect MY copy, regardless of whose copy opened the screen.
    private func refreshMyCopy() async {
        guard let mine = auth.memberSlug else { myCopy = nil; return }
        let t = (show?.title ?? initialTitle).lowercased()
        let list = (try? await API.shows(member: mine, includeArchived: true)) ?? []
        myCopy = list.first { $0.title.lowercased() == t }
    }

    private func move(to list: ShowList, id: Int) async {
        do {
            try await API.moveShow(id: id, to: list.rawValue)
            await refreshMyCopy()
        } catch let e as API.APIError where e.status == 401 {
            addAlert = AddAlert(title: "Logged out",
                                message: "Your session expired — sign in again from Home.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t move",
                                message: "Something went wrong. Please try again.")
        }
    }

    private func archive(_ id: Int) async {
        do {
            try await API.archiveShow(id: id)
            await refreshMyCopy()
        } catch let e as API.APIError where e.status == 401 {
            addAlert = AddAlert(title: "Logged out",
                                message: "Your session expired — sign in again from Home.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t archive",
                                message: "Something went wrong. Please try again.")
        }
    }

    private func restore(to list: ShowList, id: Int) async {
        do {
            try await API.restoreShow(id: id, to: list.rawValue)
            await refreshMyCopy()
            addAlert = AddAlert(title: "Added back",
                                message: "“\(title)” was added to your \(list.title) list.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t restore",
                                message: "Something went wrong. Please try again.")
        }
    }

    // Tap-row entry: instant save, no confirm step. The endpoint returns
    // the freshly recomputed summary, so update straight from that instead
    // of a separate refetch.
    private func rate(_ value: Int, season: Int?) async {
        guard let id = mineActive?.id else { return }
        do {
            if let updated = try await API.rateShow(id: id, rating: value, season: season) {
                ratings = updated
            } else {
                // Queued offline — no fresh summary to apply yet, so fold
                // the tapped value into local state ourselves. It'll be
                // replaced by the real summary next time this show loads
                // after the queue drains.
                let base = ratings ?? RatingsSummary()
                ratings = season.map { base.withMineSeason($0, value: value) } ?? base.withMine(value)
            }
        } catch let e as API.APIError where e.status == 401 {
            addAlert = AddAlert(title: "Logged out",
                                message: "Your session expired — sign in again from Home.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t save rating",
                                message: "Something went wrong. Please try again.")
        }
    }

    // Copy this show onto one of the logged-in member's lists. The POST is
    // session-scoped, so it lands on *my* lists regardless of whose show this is.
    private func addToMyList(_ list: ShowList) async {
        guard let mine = auth.memberSlug else { return }
        // Works from a loaded show or a recommendation (no `show` yet).
        let addTitle = show?.title ?? initialTitle
        addingToMine = true
        defer { addingToMine = false }
        do {
            _ = try await API.addShow(
                memberSlug: mine,
                title: addTitle,
                network: show?.network ?? initialNetwork,
                networkUrl: show?.networkUrl ?? initialNetworkUrl,
                list: list.rawValue,
                notes: nil,
                recommendedBy: nil,
                movie: show?.isMovie ?? false,
                fullSeries: show?.isFullSeries ?? false,
                watchingWith: nil,
                // The exact TMDB entry this copy is, so a same-titled show
                // (three 2026 films are "The Odyssey") can't be added instead.
                tmdbId: show?.tmdbId,
                tmdbType: show?.tmdbId == nil ? nil : ((show?.isMovie ?? false) ? "movie" : "tv")
            )
            addAlert = AddAlert(title: "Added",
                                message: "“\(addTitle)” was added to your \(list.title) list.")
            await refreshMyCopy()
        } catch let e as API.APIError where e.status == 409 {
            // Already have it (maybe archived) — reconcile so the right
            // controls appear.
            await refreshMyCopy()
            addAlert = AddAlert(title: mineArchived != nil ? "Archived" : "Already on a list",
                                message: mineArchived != nil
                                    ? "“\(addTitle)” is archived — tap a list to add it back."
                                    : "“\(addTitle)” is already on one of your lists.")
        } catch let e as API.APIError where e.status == 401 {
            addAlert = AddAlert(title: "Logged out",
                                message: "Your session expired — sign in again from Home.")
        } catch {
            addAlert = AddAlert(title: "Couldn’t add",
                                message: "Something went wrong. Please try again.")
        }
    }
}

private struct AddAlert: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}
