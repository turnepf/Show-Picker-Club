import SwiftUI

// Taste fingerprint for a member: cluster, trait signals, balance read, and
// shows aligned with (or contradicting) the vibe. GET /api/vibe?member=slug.
// Any logged-in member can view any member's vibe — switch with the picker.
struct VibeView: View {
    let initialSlug: String

    @EnvironmentObject private var auth: AuthStore
    @State private var data: VibeResponse?
    @State private var selected: String
    @State private var loading = true
    // The vibe fetch threw — "No vibe available" must not show over a
    // failed load.
    @State private var loadFailed = false
    // Trait list starts at the four signals that carry the read; the rest are
    // one tap away, matching the web's "Show all traits".
    @State private var showAllTraits = false

    init(initialSlug: String) {
        self.initialSlug = initialSlug
        _selected = State(initialValue: initialSlug)
    }

    private var members: [VibeMemberRef] { data?.members ?? [] }

    var body: some View {
        List {
            if !members.isEmpty {
                Section {
                    Picker("Member", selection: $selected) {
                        ForEach(members) { m in Text(m.name).tag(m.slug) }
                    }
                }
            }

            if let m = data?.member {
                content(for: m)
            } else if !loading {
                Section {
                    Text(loadFailed
                         ? "Couldn't load the vibe — pull down to try again."
                         : "No vibe available.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Vibe")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && data == nil { ProgressView() } }
        .refreshable { await load() }
        .task { await load() }
        .onChange(of: selected) { _, _ in Task { await load() } }
    }

    @ViewBuilder
    private func content(for m: VibeMember) -> some View {
        if m.excluded == true {
            Section { Text("This member is excluded from taste analysis.").foregroundStyle(.secondary) }
        } else if m.isSeedOnly == true {
            Section { Text("Not enough activity yet to read a vibe. Add or rate some shows first.").foregroundStyle(.secondary) }
        } else if m.noFingerprint == true {
            Section { Text("No scored shows yet — check back once the catalog has been analyzed.").foregroundStyle(.secondary) }
        } else {
            if let c = m.cluster { clusterSection(c, name: m.name) }
            if let traits = m.displayTraits { traitsSection(traits) }
            if let b = m.balance { balanceSection(b) }
            if let c = m.cluster, c.blend.count > 1 { blendSection(c.blend) }
            pickSection("Shows aligned with this vibe", m.alignedPicks ?? [],
                        canAdd: isOwnVibe, empty: "No aligned picks available.")
            pickSection("Outliers on this list", m.outlierPicks ?? [],
                        canAdd: false, empty: "Not enough scored shows to find outliers.")
            // What the fingerprint was actually computed from — without it
            // the whole read is unfalsifiable.
            if let scored = m.scoredCount, let active = m.activeCount, active > 0 {
                Section {
                    Text("Computed from \(scored) of \(active) active shows.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var isOwnVibe: Bool { auth.memberSlug == selected }

    private func clusterSection(_ c: VibeCluster, name: String?) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text(c.name).font(.title3.bold())
                Text(c.tagline).font(.subheadline).foregroundStyle(.secondary)
                Text("\(pct(c.similarity)) match").font(.caption).foregroundStyle(.secondary)
            }.padding(.vertical, 2)
        } header: {
            Text(name.map { "\($0)'s vibe" } ?? "Vibe")
        }
    }

    // Top signals first, the rest behind a toggle — ten bars at once is a
    // wall, and four of them carry the read. Each says in plain English what
    // a high score means, same copy as the web.
    private func traitsSection(_ traits: [String: Int]) -> some View {
        Section {
            ForEach(VIBE_TOP_TRAITS, id: \.self) { key in
                traitRow(key, traits[key])
            }
            if showAllTraits {
                ForEach(VIBE_TRAIT_ORDER.filter { !VIBE_TOP_TRAITS.contains($0) }, id: \.self) { key in
                    traitRow(key, traits[key])
                }
            }
            Button(showAllTraits ? "Show top signals" : "Show all traits") {
                withAnimation { showAllTraits.toggle() }
            }
            .font(.callout)
        } header: {
            Text(showAllTraits ? "Full profile" : "Top signals")
        }
    }

    @ViewBuilder
    private func traitRow(_ key: String, _ value: Int?) -> some View {
        if let v = value {
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(key).font(.subheadline)
                    Spacer()
                    Text("\(v)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                }
                ProgressView(value: Double(v), total: 100)
                    .tint(.accentColor)
                if let explain = VIBE_TRAIT_EXPLAIN[key] {
                    Text(explain)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func balanceSection(_ b: VibeBalance) -> some View {
        Section("Balance read") {
            LabeledContent("Warmth vs darkness", value: b.warmthDarknessLabel)
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text("Genre range")
                    Spacer()
                    Text("\(b.range)/100").foregroundStyle(.secondary)
                }
                // The web draws this one as a bar; a bare number doesn't say
                // whether 38 is narrow or broad.
                ProgressView(value: Double(b.range), total: 100)
                    .tint(.accentColor)
            }
            .padding(.vertical, 2)
        }
    }

    private func blendSection(_ blend: [VibeBlendItem]) -> some View {
        Section("Your blend") {
            ForEach(blend) { item in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(item.name)
                        Spacer()
                        Text(pct(item.similarity)).foregroundStyle(.secondary)
                    }
                    if let explain = VIBE_BLEND_EXPLAIN[item.name] {
                        Text(explain)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 1)
            }
        }
    }

    private func pickSection(_ title: String, _ picks: [VibePick],
                             canAdd: Bool, empty: String) -> some View {
        Section(title) {
            if picks.isEmpty {
                Text(empty).font(.callout).foregroundStyle(.secondary)
            }
            ForEach(picks) { p in
                VibePickRow(pick: p, canAdd: canAdd)
            }
        }
    }

    private func pct(_ sim: Double) -> String { "\(Int((sim * 100).rounded()))%" }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            data = try await API.vibe(member: selected)
            loadFailed = false
        } catch {
            loadFailed = true
        }
    }
}

// A pick reads as an ordinary show card and opens the same detail screen as
// every other row in the app — it used to be a text line with no way through.
// The "+" asks which list and takes notes, rather than silently choosing.
private struct VibePickRow: View {
    let pick: VibePick
    let canAdd: Bool

    @EnvironmentObject private var auth: AuthStore
    @State private var added = false
    @State private var adding = false
    @State private var choosing = false
    @State private var chosenList: ShowList = .next
    @State private var notes = ""

    var body: some View {
        HStack {
            if let id = pick.showId {
                NavigationLink(value: Route.detail(id: id, title: pick.title,
                                                   network: pick.network, rating: pick.rating)) {
                    ShowRow(pick, caption: caption)
                }
            } else {
                // No live copy of this title anywhere in the club, so there's
                // no show card to open — the row still adds.
                ShowRow(pick, caption: caption)
            }
            if canAdd {
                if added {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Button {
                        choosing = true
                    } label: {
                        Image(systemName: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    .disabled(adding)
                }
            }
        }
        .alert("Add \(pick.title)", isPresented: $choosing) {
            TextField("Notes (optional)", text: $notes)
            ForEach(ShowList.allCases) { l in
                Button(l.title) {
                    chosenList = l
                    Task { await add() }
                }
            }
            Button("Cancel", role: .cancel) { notes = "" }
        } message: {
            Text("Which list?")
        }
    }

    // Genres ride in the caption line; the network is already ShowRow's
    // default caption, so only replace it when there's a genre to show.
    private var caption: String? {
        guard let g = pick.genres, !g.isEmpty else { return nil }
        guard let n = pick.network, !n.isEmpty else { return g }
        return "\(n) · \(g)"
    }

    private func add() async {
        guard let mine = auth.memberSlug else { return }
        adding = true
        defer { adding = false }
        let note = notes.trimmingCharacters(in: .whitespaces)
        notes = ""
        do {
            _ = try await API.addShow(
                memberSlug: mine, title: pick.title, network: pick.network,
                networkUrl: pick.networkUrl, list: chosenList.rawValue,
                notes: note.isEmpty ? nil : note, recommendedBy: nil,
                movie: (pick.movie ?? 0) == 1, fullSeries: false,
                watchingWith: nil)
            added = true
        } catch {
            // 409 (already on a list) or other — treat as already handled.
            added = true
        }
    }
}
