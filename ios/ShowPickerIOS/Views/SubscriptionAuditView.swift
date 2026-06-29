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

    var body: some View {
        List {
            if let a = audit {
                Section {
                    LabeledContent("Services", value: "\(a.totals.serviceCount)")
                    LabeledContent("Monthly spend", value: money(a.totals.monthlySpendCents))
                    LabeledContent("Potential savings") {
                        Text(money(a.totals.potentialSavingsCents))
                            .foregroundStyle(a.totals.potentialSavingsCents > 0 ? .green : .secondary)
                    }
                } header: {
                    Text("Totals")
                } footer: {
                    Text("Estimated from standard plan prices. Edit any service to set your real price.")
                }

                ForEach(a.services) { svc in
                    Section {
                        NavigationLink {
                            SubscriptionServiceEditView(service: svc) { await load() }
                        } label: {
                            serviceRow(svc)
                        }
                    }
                }

                Section {
                    Button {
                        addingService = true
                    } label: {
                        Label("Add a service", systemImage: "plus.circle")
                    }
                } footer: {
                    Text("Track a service you pay for that isn't tied to any show on your lists.")
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
            Button("Cancel", role: .cancel) { newServiceName = "" }
            Button("Add") { Task { await addManual() } }
        } message: {
            Text("Enter the name of a streaming service you pay for.")
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

    private func countsSummary(_ c: SubscriptionCounts) -> String {
        var parts: [String] = []
        if c.watching > 0 { parts.append("\(c.watching) watching") }
        if c.waiting > 0 { parts.append("\(c.waiting) waiting") }
        if c.next > 0 { parts.append("\(c.next) up next") }
        if c.recommending > 0 { parts.append("\(c.recommending) rec'd") }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        loading = true
        defer { loading = false }
        audit = try? await API.subscriptions()
    }

    private func addManual() async {
        let name = newServiceName.trimmingCharacters(in: .whitespaces)
        newServiceName = ""
        guard !name.isEmpty else { return }
        try? await API.updateSubscription(network: name, status: "subscribed", isManual: true)
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
                            Text(sh.title)
                            Spacer()
                            Text(ShowList(rawValue: sh.list)?.title ?? sh.list.capitalized)
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
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
        try? await API.updateSubscription(
            network: service.network, status: status, monthlyPriceCents: cents,
            resubscribeDate: resub, isManual: service.isManual ? true : nil)
        await onChange()
        dismiss()
    }

    private func remove() async {
        working = true
        defer { working = false }
        try? await API.updateSubscription(network: service.network, remove: true)
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

// Format cents as a dollar string.
private func money(_ cents: Int) -> String {
    String(format: "$%.2f", Double(cents) / 100)
}
