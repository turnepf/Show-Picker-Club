import SwiftUI

// Operator tool: everyone waiting to get in. /join signup requests are
// approved (runs create-member) or rejected via /api/admin-signup-requests;
// self-enrolled members held off the roster (members.approved = 0) wait in
// the same queue and are approved via /api/admin-member-approve — matching
// the web /admin page.
struct SignupRequestsView: View {
    @State private var requests: [SignupRequest] = []
    @State private var held: [AdminMember] = []
    @State private var loading = true
    @State private var working: Int?
    @State private var workingSlug: String?
    @State private var banner: String?

    private var pending: [SignupRequest] { requests.filter { $0.status == "pending" } }
    private var reviewed: [SignupRequest] { requests.filter { $0.status != "pending" } }

    var body: some View {
        List {
            if let b = banner {
                Section { Text(b).font(.callout) }
            }
            if !held.isEmpty {
                Section {
                    ForEach(held) { heldRow($0) }
                } header: {
                    Text("Held members (\(held.count))")
                } footer: {
                    Text("Self-enrolled via Apple/Google — they can already use their own lists, but stay off the roster until approved.")
                }
            }
            Section("Pending (\(pending.count))") {
                if pending.isEmpty {
                    Text("No pending requests.").foregroundStyle(.secondary)
                } else {
                    ForEach(pending) { pendingRow($0) }
                }
            }
            if !reviewed.isEmpty {
                Section("Reviewed") {
                    ForEach(reviewed) { reviewedRow($0) }
                }
            }
        }
        .navigationTitle("New members")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && requests.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
    }

    @ViewBuilder private func heldRow(_ m: AdminMember) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(m.personName).font(.body)
            Text(heldContact(m)).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button {
                    Task { await approveHeld(m) }
                } label: {
                    Label("Approve", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .tint(.green)
                Spacer()
                if workingSlug == m.slug { ProgressView() }
            }
            .disabled(workingSlug != nil)
        }
        .padding(.vertical, 2)
    }

    private func heldContact(_ m: AdminMember) -> String {
        var parts: [String] = ["@\(m.slug)"]
        if let via = m.enrolledVia, !via.isEmpty { parts.append("via \(via)") }
        if let email = m.emails.first { parts.append(email) }
        return parts.joined(separator: " · ")
    }

    private func approveHeld(_ m: AdminMember) async {
        workingSlug = m.slug
        defer { workingSlug = nil }
        banner = nil
        do {
            let res = try await API.approveMember(slug: m.slug)
            if let e = res.error { banner = "Couldn't approve: \(e)" }
            else { banner = "Approved \(m.personName)" }
            await load()
        } catch {
            banner = "Network error. Try again."
        }
    }

    @ViewBuilder private func pendingRow(_ r: SignupRequest) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(r.fullName).font(.body)
            Text(contact(r)).font(.caption).foregroundStyle(.secondary)
            HStack(spacing: 12) {
                Button {
                    Task { await act(r, action: "approve") }
                } label: {
                    Label("Approve", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderless)
                .tint(.green)
                Button(role: .destructive) {
                    Task { await act(r, action: "reject") }
                } label: {
                    Label("Reject", systemImage: "xmark.circle")
                }
                .buttonStyle(.borderless)
                Spacer()
                if working == r.id { ProgressView() }
            }
            .disabled(working != nil)
        }
        .padding(.vertical, 2)
    }

    // Reviewed rows carry a Hide: dismisses the request for good (the
    // server stops returning it), so the queue empties once processed.
    @ViewBuilder private func reviewedRow(_ r: SignupRequest) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(r.fullName).font(.body)
            HStack(spacing: 6) {
                Text(r.status.capitalized)
                    .foregroundStyle(r.status == "approved" ? .green : .secondary)
                if let s = r.createdMemberSlug { Text("· @\(s)") }
                Spacer()
                if working == r.id {
                    ProgressView()
                } else {
                    Button("Hide") { Task { await act(r, action: "hide") } }
                        .buttonStyle(.borderless)
                        .disabled(working != nil)
                }
            }
            .font(.caption)
        }
    }

    private func contact(_ r: SignupRequest) -> String {
        [r.email, r.phone].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private func act(_ r: SignupRequest, action: String) async {
        working = r.id
        defer { working = nil }
        banner = nil
        do {
            let res = try await API.actOnSignupRequest(id: r.id, action: action)
            if let e = res.error {
                banner = "Couldn't \(action): \(e)"
            } else if action == "approve" {
                banner = "Approved \(r.fullName)" + (res.created?.slug.map { " → @\($0)" } ?? "")
            } else if action == "reject" {
                banner = "Rejected \(r.fullName)"
            }
            await load()
        } catch {
            banner = "Network error. Try again."
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        requests = (try? await API.signupRequests()) ?? []
        held = ((try? await API.adminMembers()) ?? []).filter { $0.approved == false }
    }
}
