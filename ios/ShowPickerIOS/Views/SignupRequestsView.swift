import SwiftUI

// Operator tool: review /join signup requests and approve (runs create-member)
// or reject. GET/POST /api/admin-signup-requests.
struct SignupRequestsView: View {
    @State private var requests: [SignupRequest] = []
    @State private var loading = true
    @State private var working: Int?
    @State private var banner: String?

    private var pending: [SignupRequest] { requests.filter { $0.status == "pending" } }
    private var reviewed: [SignupRequest] { requests.filter { $0.status != "pending" } }

    var body: some View {
        List {
            if let b = banner {
                Section { Text(b).font(.callout) }
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
        .navigationTitle("Signup Requests")
        .navigationBarTitleDisplayMode(.inline)
        .overlay { if loading && requests.isEmpty { ProgressView() } }
        .task { await load() }
        .refreshable { await load() }
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

    @ViewBuilder private func reviewedRow(_ r: SignupRequest) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(r.fullName).font(.body)
            HStack(spacing: 6) {
                Text(r.status.capitalized)
                    .foregroundStyle(r.status == "approved" ? .green : .secondary)
                if let s = r.createdMemberSlug { Text("· @\(s)") }
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
            } else {
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
    }
}
