import SwiftUI

// Personal subscription audit: groups your active shows by streaming service
// and assigns each a verdict (keep / pause / start / cancel), with editable
// status, price, and resubscribe reminder. GET/PUT /api/subscriptions.
// Reached from your own MemberView only.
struct SubscriptionAuditView: View {
    @State private var audit: SubscriptionAudit?
    @State private var loading = true
    @State private var addingService = false
    @State private var newServiceName = ""
    @State private var newServicePrice = ""
    @State private var errorText: String?
    // Network currently being saved inline, so its controls can't be
    // double-tapped while the round trip is in flight.
    @State private var saving: String?
    @State private var showingHousehold = false

    var body: some View {
        List {
            if let err = errorText {
                Section { Text(err).foregroundStyle(.red) }
            }
            if let a = audit {
                Section {
                    Button {
                        showingHousehold = true
                    } label: {
                        HStack {
                            Label(householdLabel(a), systemImage: "person.2")
                                .lineLimit(2)
                            Spacer()
                            Text((a.household?.isEmpty ?? true) ? "Invite" : "Manage")
                                .foregroundStyle(.secondary)
                        }
                    }
                } header: {
                    Text("Household")
                } footer: {
                    Text("Invite whoever you share streaming services with. Their shows pool into this audit, so a service one of you is watching counts as a keep — and every show says who it belongs to.")
                }

                Section {
                    LabeledContent("Services", value: "\(a.totals.serviceCount)")
                    LabeledContent("Monthly spend", value: money(a.totals.monthlySpendCents))
                    LabeledContent("Potential savings") {
                        Text(money(a.totals.potentialSavingsCents))
                            .foregroundStyle(a.totals.potentialSavingsCents > 0 ? .green : .secondary)
                    }
                    // The headline the numbers add up to — the web leads with
                    // this, and it's the whole reason to open the screen.
                    Text(a.totals.potentialSavingsCents > 0
                         ? "You could trim about \(money(a.totals.potentialSavingsCents))/mo by pausing or cancelling the services nothing on your list needs right now."
                         : "Everything you're paying for is pulling its weight right now. Nice.")
                        .font(.callout)
                        .foregroundStyle(a.totals.potentialSavingsCents > 0 ? .primary : .secondary)
                } header: {
                    Text("Totals")
                } footer: {
                    Text("Estimated from standard plan prices. Edit any service to set your real price.")
                }

                if a.services.isEmpty {
                    Section {
                        Text("No streaming services to audit yet. Once you add shows with a network on your list, they'll show up here grouped by service — with a keep / pause / cancel call for each.")
                            .foregroundStyle(.secondary)
                    }
                }

                bucketSections(a)

                Section {
                    Button {
                        addingService = true
                    } label: {
                        Label("Add a service", systemImage: "plus.circle")
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Track a service you pay for that isn't tied to any show on your lists.")
                        Text("💡 Set a resubscribe date on a paused service and it lands on your Shows calendar, right next to your premiere and finale dates.")
                        Text("Audited from the shows on your list · \(a.today)")
                    }
                }
            } else if !loading {
                Section {
                    Text("Couldn't load your subscriptions — pull down to try again.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Subscriptions")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && audit == nil { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
        .alert("Add a service", isPresented: $addingService) {
            TextField("Service name", text: $newServiceName)
            TextField("Monthly price", text: $newServicePrice)
                .keyboardType(.decimalPad)
            Button("Cancel", role: .cancel) { newServiceName = ""; newServicePrice = "" }
            Button("Add") { Task { await addManual() } }
        } message: {
            Text("Enter the name of a streaming service you pay for, and what it costs per month.")
        }
        .sheet(isPresented: $showingHousehold) {
            NavigationStack {
                HouseholdPickerView { await load() }
            }
        }
    }

    private func householdLabel(_ a: SubscriptionAudit) -> String {
        let hh = a.household ?? []
        if hh.isEmpty { return "Just your shows" }
        return "You + " + hh.map(\.name).joined(separator: ", ")
    }

    // verdict → bucket, mirroring subscriptions.html so the two screens tell
    // the same story in the same order.
    private struct Bucket {
        let key: String
        let title: String
        let blurb: String
        let verdicts: [String]
    }

    private static let buckets: [Bucket] = [
        Bucket(key: "keep", title: "Keep", blurb: "you're watching something here now", verdicts: ["keep"]),
        Bucket(key: "pause", title: "Pause & save", blurb: "nothing active — cancel and come back", verdicts: ["pause", "pause_tba"]),
        Bucket(key: "start", title: "Start or skip", blurb: "queued up but not started", verdicts: ["start"]),
        Bucket(key: "cancel", title: "Cancel candidates", blurb: "nothing here needs you", verdicts: ["cancel"]),
        Bucket(key: "manual", title: "Other services", blurb: "tracked manually", verdicts: ["manual"]),
    ]

    // Grouped by what to DO about each service, not alphabetically: the same
    // buckets, order and blurbs as the web. Kept out of `body` so the view
    // builder there stays small enough to type-check quickly.
    @ViewBuilder
    private func bucketSections(_ a: SubscriptionAudit) -> some View {
        ForEach(Self.buckets, id: \.key) { bucket in
            let items = a.services.filter { bucket.verdicts.contains($0.verdict) }
            if !items.isEmpty {
                Section {
                    ForEach(items) { svc in
                        serviceCard(svc)
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(bucket.title) · \(items.count)")
                        Text(bucket.blurb)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .textCase(nil)
                    }
                }
            }
        }
    }

    // One service: the summary row, the reason it landed in this bucket, the
    // status control, the resubscribe date when it's relevant, and the shows
    // behind the verdict. Status and date save on the spot — the edit screen
    // is now only needed for the price.
    @ViewBuilder
    private func serviceCard(_ svc: SubscriptionService) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            serviceRow(svc)

            Text(reason(svc))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Picker("Status", selection: Binding(
                get: { svc.effectiveStatus },
                set: { newValue in Task { await setStatus(svc, newValue) } }
            )) {
                Text("Subscribed").tag("subscribed")
                Text("Paused").tag("paused")
                Text("Cancelled").tag("cancelled")
            }
            .pickerStyle(.segmented)
            .disabled(saving == svc.network)

            // Paused, or the audit thinks it should be: put the date one tap
            // away, pre-filled with the suggestion.
            if svc.effectiveStatus == "paused" || svc.verdict == "pause" || svc.verdict == "pause_tba" {
                DatePicker(
                    "Resubscribe",
                    selection: Binding(
                        get: { Self.parseDay(svc.resubscribeDate ?? svc.suggestedResubscribeDate) ?? Date() },
                        set: { newValue in Task { await setResubscribe(svc, newValue) } }
                    ),
                    displayedComponents: .date
                )
                .font(.callout)
                .disabled(saving == svc.network)
            }

            if !svc.shows.isEmpty {
                DisclosureGroup("Why? (\(svc.shows.count) show\(svc.shows.count == 1 ? "" : "s"))") {
                    ForEach(svc.shows) { sh in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(ShowList(rawValue: sh.list)?.title ?? sh.list.capitalized)
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                    .frame(width: 64, alignment: .leading)
                                Text(sh.title + ((sh.fullSeries ?? 0) == 1 ? " (ended)" : ""))
                                    .font(.caption)
                                Spacer()
                                if let d = sh.nextSeasonDate, !d.isEmpty {
                                    Text("returns \(Self.longDay(d))")
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            // Whose show this is. Only present once a
                            // household is pooling more than one person's
                            // lists — a solo audit sends no viewers at all.
                            if let line = Self.viewerLine(sh) {
                                Text(line)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .padding(.leading, 64)
                            }
                        }
                    }
                }
                .font(.caption)
            }

            NavigationLink {
                SubscriptionServiceEditView(service: svc) { await load() }
            } label: {
                Text(svc.isManual ? "Price & details" : "Price")
                    .font(.caption)
            }
        }
        .padding(.vertical, 4)
    }

    // "Cancel and resubscribe around Mar 2026, when Severance returns" —
    // naming the show is what makes the verdict act on, not just a label.
    private func reason(_ svc: SubscriptionService) -> String {
        switch svc.verdict {
        case "keep":
            // In a household, the verdict can rest on somebody else's show —
            // so name whoever is actually watching, not just the title.
            let watching = svc.shows.filter { $0.list == "watching" }
            let head = watching.prefix(3).map { sh -> String in
                let names = sh.watchers.map(\.name)
                return names.isEmpty ? sh.title : "\(sh.title) (\(Self.sentenceList(names)))"
            }.joined(separator: ", ")
            return "Active now: \(head)\(watching.count > 3 ? "…" : "")."
        case "pause":
            let returning = svc.shows.first { $0.list == "waiting" && $0.nextSeasonDate == svc.suggestedResubscribeDate }
            let who = returning?.title ?? "A show"
            let when = Self.monthYear(svc.suggestedResubscribeDate)
            return "Nothing to watch right now. Cancel and resubscribe around \(when), when \(who) returns."
        case "pause_tba":
            return "Nothing active. You're waiting on a renewal, but no premiere date is announced yet — pause until one is."
        case "start":
            return "You have shows queued up here but aren't watching any yet. Start one this month or skip the service."
        case "cancel":
            return "Nothing watching, waiting, or up next — your shows here are finished. Safe to cancel."
        default:
            return "Tracked manually — no shows on your lists use it."
        }
    }

    private func serviceRow(_ svc: SubscriptionService) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(svc.network).font(.body.weight(.semibold))
                Spacer()
                Text(money(svc.monthlyPriceCents ?? 0)).font(.callout).foregroundStyle(.secondary)
            }
            HStack(spacing: 8) {
                VerdictBadge(verdict: svc.verdict)
                if svc.effectiveStatus != "subscribed" {
                    Text(svc.effectiveStatus.capitalized)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(countsSummary(svc.counts))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    // "You · Dorothy (Next Up)" — who has this title, annotated with their own
    // list when it differs from the headline list the verdict was computed
    // from (pooling keeps the most-active list, so those can disagree).
    // Returns nil when the audit isn't pooling a household.
    static func viewerLine(_ sh: SubscriptionShow) -> String? {
        guard let viewers = sh.viewers, !viewers.isEmpty else { return nil }
        return viewers.map { v in
            v.list == sh.list
                ? v.name
                : "\(v.name) (\(ShowList(rawValue: v.list)?.title ?? v.list.capitalized))"
        }.joined(separator: " · ")
    }

    // "You", "You and Dorothy", "You, Dorothy and Sam" — for prose, where the
    // interpunct list above would read as noise.
    static func sentenceList(_ names: [String]) -> String {
        guard let last = names.last else { return "" }
        if names.count == 1 { return last }
        return names.dropLast().joined(separator: ", ") + " and " + last
    }

    private func countsSummary(_ c: SubscriptionCounts) -> String {
        var parts: [String] = []
        if c.watching > 0 { parts.append("\(c.watching) watching") }
        if c.waiting > 0 { parts.append("\(c.waiting) waiting") }
        if c.next > 0 { parts.append("\(c.next) next up") }
        if c.recommending > 0 { parts.append("\(c.recommending) loved") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        audit = try? await API.subscriptions()
    }

    // Inline saves: change lands immediately, then the audit reloads so the
    // verdict buckets and totals re-sort around it.
    @MainActor
    private func setStatus(_ svc: SubscriptionService, _ status: String) async {
        saving = svc.network
        defer { saving = nil }
        do {
            try await API.updateSubscription(network: svc.network, status: status,
                                             isManual: svc.isManual ? true : nil)
            errorText = nil
        } catch {
            errorText = API.failureLine(error, action: "update \(svc.network)")
        }
        await load()
    }

    @MainActor
    private func setResubscribe(_ svc: SubscriptionService, _ date: Date) async {
        saving = svc.network
        defer { saving = nil }
        do {
            try await API.updateSubscription(network: svc.network,
                                             resubscribeDate: .some(Self.dayString(date)),
                                             isManual: svc.isManual ? true : nil)
            errorText = nil
        } catch {
            errorText = API.failureLine(error, action: "set the date for \(svc.network)")
        }
        await load()
    }

    // Dates on the wire are plain "YYYY-MM-DD" days, not timestamps.
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func parseDay(_ s: String?) -> Date? {
        guard let s, !s.isEmpty else { return nil }
        return dayFormatter.date(from: s)
    }

    private static func dayString(_ d: Date) -> String { dayFormatter.string(from: d) }

    // "Mar 2026" for the resubscribe sentence.
    private static func monthYear(_ s: String?) -> String {
        guard let date = parseDay(s) else { return "then" }
        let f = DateFormatter()
        f.dateFormat = "MMM yyyy"
        return f.string(from: date)
    }

    // "Mar 3, 2026" for the per-show return dates.
    private static func longDay(_ s: String) -> String {
        guard let date = parseDay(s) else { return s }
        let f = DateFormatter()
        f.dateStyle = .medium
        return f.string(from: date)
    }

    private func addManual() async {
        let name = newServiceName.trimmingCharacters(in: .whitespaces)
        // Web takes the price in the same dialog; without it a new manual
        // service lands at $0 and quietly skews the monthly total.
        let cents = Double(newServicePrice.trimmingCharacters(in: .whitespaces)).map { Int($0 * 100) }
        newServiceName = ""
        newServicePrice = ""
        guard !name.isEmpty else { return }
        do {
            try await API.updateSubscription(network: name, status: "subscribed",
                                             monthlyPriceCents: cents, isManual: true)
            errorText = nil
        } catch {
            errorText = API.failureLine(error, action: "add \(name)")
        }
        await load()
    }
}

// Verdict pill, matching the web's color coding.
struct VerdictBadge: View {
    let verdict: String
    private var label: String {
        switch verdict {
        case "keep": return "Keep"
        case "pause": return "Pause"
        case "pause_tba": return "Pause (TBA)"
        case "start": return "Start"
        case "cancel": return "Cancel"
        default: return "Manual"
        }
    }
    private var color: Color {
        switch verdict {
        case "keep": return .green
        case "pause", "pause_tba": return .orange
        case "start": return .blue
        case "cancel": return .red
        default: return .gray
        }
    }
    var body: some View {
        Text(label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.18), in: Capsule())
            .foregroundStyle(color)
    }
}

private struct SubscriptionServiceEditView: View {
    let service: SubscriptionService
    let onChange: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var status: String
    @State private var priceText: String
    @State private var setResubscribe: Bool
    @State private var resubscribeDate: Date
    @State private var working = false
    @State private var errorText: String?

    init(service: SubscriptionService, onChange: @escaping () async -> Void) {
        self.service = service
        self.onChange = onChange
        _status = State(initialValue: service.effectiveStatus)
        _priceText = State(initialValue: String(format: "%.2f", Double(service.monthlyPriceCents ?? 0) / 100))
        let existing = service.resubscribeDate ?? service.suggestedResubscribeDate
        _setResubscribe = State(initialValue: existing != nil)
        _resubscribeDate = State(initialValue: SubscriptionServiceEditView.parseDate(existing) ?? Date())
    }

    var body: some View {
        Form {
            Section {
                Picker("Status", selection: $status) {
                    Text("Subscribed").tag("subscribed")
                    Text("Paused").tag("paused")
                    Text("Cancelled").tag("cancelled")
                }
                HStack {
                    Text("Price")
                    Spacer()
                    Text("$")
                    TextField("0.00", text: $priceText)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 90)
                    Text("/mo").foregroundStyle(.secondary)
                }
            } header: {
                Text(service.network)
            } footer: {
                Text(verdictExplanation)
            }

            Section {
                Toggle("Set resubscribe reminder", isOn: $setResubscribe)
                if setResubscribe {
                    DatePicker("Resubscribe on", selection: $resubscribeDate, displayedComponents: .date)
                }
            } footer: {
                Text("Adds to your calendar feed so you remember to come back when the next season lands.")
            }

            if !service.shows.isEmpty {
                Section("Why") {
                    ForEach(service.shows) { sh in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(sh.title)
                                if let line = SubscriptionAuditView.viewerLine(sh) {
                                    Text(line).font(.caption2).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            Text(ShowList(rawValue: sh.list)?.title ?? sh.list.capitalized)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if let err = errorText {
                Section { Text(err).foregroundStyle(.red) }
            }

            Section {
                Button("Save") { Task { await save() } }.disabled(working)
                if service.isManual {
                    Button("Remove service", role: .destructive) { Task { await remove() } }
                        .disabled(working)
                }
            }
        }
        .navigationTitle(service.network)
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if working { ProgressView().controlSize(.large) } }
    }

    private var verdictExplanation: String {
        switch service.verdict {
        case "keep": return "You're actively watching something here."
        case "pause": return "Nothing active now, but a waiting show has an announced next season — pause until then."
        case "pause_tba": return "Only waiting shows, with no announced next-season date yet."
        case "start": return "Only up-next shows — start one or skip the service."
        case "cancel": return "Nothing active, waiting, or queued here."
        default: return "A service you track manually."
        }
    }

    private func save() async {
        working = true
        defer { working = false }
        let cents = Int((Double(priceText) ?? 0) * 100)
        let resub: String?? = setResubscribe
            ? .some(SubscriptionServiceEditView.formatDate(resubscribeDate))
            : .some(nil)
        do {
            try await API.updateSubscription(
                network: service.network, status: status, monthlyPriceCents: cents,
                resubscribeDate: resub, isManual: service.isManual ? true : nil)
        } catch {
            // Stay on the sheet so nothing looks saved when it wasn't.
            errorText = API.failureLine(error, action: "save")
            return
        }
        await onChange()
        dismiss()
    }

    private func remove() async {
        working = true
        defer { working = false }
        do {
            try await API.updateSubscription(network: service.network, remove: true)
        } catch {
            errorText = API.failureLine(error, action: "remove \(service.network)")
            return
        }
        await onChange()
        dismiss()
    }

    private static func parseDate(_ s: String?) -> Date? {
        guard let s else { return nil }
        return isoFormatter.date(from: s)
    }
    private static func formatDate(_ d: Date) -> String {
        isoFormatter.string(from: d)
    }
    private static let isoFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}

// Pick which club members share your household, so the audit pools everyone's
// shows. Replaces the whole set on Save.
private struct HouseholdPickerView: View {
    let onSaved: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var info: HouseholdInfo?
    @State private var invite: HouseholdInvite?
    @State private var loading = true
    @State private var working = false
    @State private var errorText: String?
    @State private var confirmingRemoval: HouseholdMember?

    var body: some View {
        List {
            if let err = errorText {
                Section { Text(err).foregroundStyle(.red) }
            }

            Section {
                if let invite {
                    // ShareLink gets a URL, not the String the API hands back.
                    // A String is offered to the system as plain text, which
                    // drops Messages, Mail and AirDrop from the sheet — the
                    // targets that matter for an invite.
                    if let url = URL(string: invite.url) {
                        ShareLink(item: url,
                                  subject: Text("Join my household on Show Picker"),
                                  message: Text("Join my household — the subscription audit pools our shows so we're not counted twice for the same service.")) {
                            Label("Share invite link", systemImage: "square.and.arrow.up")
                        }
                    }
                    Text(invite.url)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                } else {
                    Button {
                        Task { await makeInvite() }
                    } label: {
                        Label("Invite someone to your household", systemImage: "person.badge.plus")
                    }
                    .disabled(working)
                }
            } header: {
                Text("Invite")
            } footer: {
                Text("Send the link to whoever you share streaming services with — the audit pools their shows with yours once they accept. The link works for 7 days.")
            }

            Section {
                if let members = currentMembers, !members.isEmpty {
                    ForEach(members) { m in
                        HStack {
                            Text(m.name)
                            Spacer()
                            Button("Remove", role: .destructive) { confirmingRemoval = m }
                                .font(.caption)
                                .disabled(working)
                        }
                    }
                } else if !loading {
                    Text("Nobody yet — your audit covers only your own shows.")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text("In your household")
            }
        }
        .navigationTitle("Household")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && info == nil { ProgressView() } }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
        .confirmationDialog(
            confirmingRemoval.map { "Remove \($0.name) from your household?" } ?? "",
            isPresented: Binding(get: { confirmingRemoval != nil },
                                 set: { if !$0 { confirmingRemoval = nil } }),
            titleVisibility: .visible
        ) {
            Button("Remove", role: .destructive) {
                if let m = confirmingRemoval { Task { await remove(m) } }
            }
            Button("Cancel", role: .cancel) { confirmingRemoval = nil }
        } message: {
            Text("Their shows stop counting toward your audit. Nothing on either of your lists changes.")
        }
        .task { await load() }
    }

    // The roster entries whose slugs are actually in my household. The
    // endpoint returns both, and only the intersection belongs on screen now
    // that membership is invite-driven rather than picked from a list.
    private var currentMembers: [HouseholdMember]? {
        guard let info else { return nil }
        let mine = Set(info.household)
        return info.members.filter { mine.contains($0.slug) }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            info = try await API.household()
        } catch {
            errorText = API.failureLine(error, action: "load your household")
        }
    }

    private func makeInvite() async {
        working = true
        defer { working = false }
        do {
            invite = try await API.householdInvite()
            errorText = nil
        } catch {
            errorText = API.failureLine(error, action: "create an invite")
        }
    }

    private func remove(_ member: HouseholdMember) async {
        confirmingRemoval = nil
        working = true
        defer { working = false }
        do {
            _ = try await API.removeFromHousehold(slug: member.slug)
            await load()
            await onSaved()
        } catch {
            errorText = API.failureLine(error, action: "remove \(member.name)")
        }
    }
}

// "$12.99" — prices are stored in cents everywhere, so every screen that
// shows one formats it here. (Lost when the household picker was rewritten;
// the four call sites above are the only users.)
private func money(_ cents: Int) -> String {
    String(format: "$%.2f", Double(cents) / 100)
}
