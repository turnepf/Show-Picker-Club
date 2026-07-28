import SwiftUI
import ShowPickerCore

struct GroupDetailWatchView: View {
    @EnvironmentObject private var auth: WatchAuth
    let group: Group
    @State private var detail: GroupDetail?
    @State private var loading = false
    @State private var errorText: String?

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if let errorText {
                VStack(spacing: 8) {
                    Text(errorText).font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Try Again") { Task { await load() } }
                        .font(.caption)
                }
                .padding(.horizontal)
            } else if let detail = detail {
                List {
                    Section("Members") {
                        ForEach(detail.members) { member in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(member.displayName).font(.body)
                                Text("\(member.showCount) show\(member.showCount == 1 ? "" : "s")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(group.name)
        .task { await load() }
    }

    private func load() async {
        guard auth.isLoggedIn else { return }
        loading = true
        defer { loading = false }
        do {
            detail = try await WatchAPI.groupDetail(id: group.id, cookie: auth.cookieHeader)
            errorText = nil
        } catch {
            errorText = "Couldn't load group."
        }
    }
}
