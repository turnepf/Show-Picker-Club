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
                Section { Text("No vibe available.").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Vibe")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && data == nil { ProgressView() } }
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
            if let picks = m.alignedPicks, !picks.isEmpty {
                pickSection("Shows aligned with this vibe", picks, canAdd: isOwnVibe)
            }
            if let outs = m.outlierPicks, !outs.isEmpty {
                pickSection("Outliers on this list", outs, canAdd: false)
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

    private func traitsSection(_ traits: [String: Int]) -> some View {
        Section("Trait signals") {
            ForEach(VIBE_TRAIT_ORDER, id: \.self) { key in
                if let v = traits[key] {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(key).font(.subheadline)
                            Spacer()
                            Text("\(v)").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary)
                        }
                        ProgressView(value: Double(v), total: 100)
                            .tint(.accentColor)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func balanceSection(_ b: VibeBalance) -> some View {
        Section("Balance read") {
            LabeledContent("Warmth vs darkness", value: b.warmthDarknessLabel)
            LabeledContent("Genre range", value: "\(b.range)/100")
        }
    }

    private func blendSection(_ blend: [VibeBlendItem]) -> some View {
        Section("Your blend") {
            ForEach(blend) { item in
                HStack {
                    Text(item.name)
                    Spacer()
                    Text(pct(item.similarity)).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func pickSection(_ title: String, _ picks: [VibePick], canAdd: Bool) -> some View {
        Section(title) {
            ForEach(picks) { p in
                VibePickRow(pick: p, canAdd: canAdd)
            }
        }
    }

    private func pct(_ sim: Double) -> String { "\(Int((sim * 100).rounded()))%" }

    private func load() async {
        loading = true
        defer { loading = false }
        data = try? await API.vibe(member: selected)
    }
}

private struct VibePickRow: View {
    let pick: VibePick
    let canAdd: Bool

    @EnvironmentObject private var auth: AuthStore
    @State private var added = false
    @State private var adding = false

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(pick.title).font(.body)
                let meta = [pick.network, pick.rating.map { "★ \($0)" }]
                    .compactMap { $0 }.joined(separator: " · ")
                if !meta.isEmpty {
                    Text(meta).font(.caption).foregroundStyle(.secondary)
                }
                if let g = pick.genres, !g.isEmpty {
                    Text(g).font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if canAdd {
                if added {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                } else {
                    Button {
                        Task { await add() }
                    } label: {
                        Image(systemName: "plus.circle")
                    }
                    .buttonStyle(.borderless)
                    .disabled(adding)
                }
            }
        }
    }

    private func add() async {
        guard let mine = auth.memberSlug else { return }
        adding = true
        defer { adding = false }
        do {
            _ = try await API.addShow(
                memberSlug: mine, title: pick.title, network: pick.network,
                networkUrl: pick.networkUrl, list: ShowList.next.rawValue,
                notes: nil, recommendedBy: nil, movie: false, fullSeries: false,
                watchingWith: nil)
            added = true
        } catch {
            // 409 (already on a list) or other — treat as already handled.
            added = true
        }
    }
}
