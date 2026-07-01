import SwiftUI
import ShowPickerCore

// Screen 1: the four lists, each with a count. Tapping one drills into its
// shows. Loads your shows once (public read) and filters per list.
struct ListsView: View {
    @EnvironmentObject private var auth: WatchAuth
    @State private var shows: [Show] = []
    @State private var loading = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Group {
                if !auth.isLoggedIn {
                    signInPrompt
                } else if loading && shows.isEmpty {
                    ProgressView()
                } else if let errorText, shows.isEmpty {
                    Text(errorText).font(.footnote).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                } else {
                    List {
                        ForEach(ShowList.allCases) { list in
                            let items = shows.filter { $0.list == list.rawValue && !$0.isArchived }
                            NavigationLink {
                                ListShowsView(list: list, shows: items)
                            } label: {
                                HStack(spacing: 8) {
                                    Circle().fill(Self.color(for: list)).frame(width: 10, height: 10)
                                    Text(list.title)
                                    Spacer()
                                    Text("\(items.count)").foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("My Shows")
        }
        .task(id: auth.memberSlug) { await load() }
    }

    private var signInPrompt: some View {
        VStack(spacing: 8) {
            Image(systemName: "iphone").font(.title2).foregroundStyle(.secondary)
            Text("Open Show Picker on your iPhone and sign in.")
                .font(.footnote).multilineTextAlignment(.center)
        }
        .padding()
    }

    private func load() async {
        guard let slug = auth.memberSlug else { shows = []; return }
        loading = true
        defer { loading = false }
        do {
            shows = try await WatchAPI.shows(member: slug, cookie: auth.cookieHeader)
        } catch {
            errorText = "Couldn't load your shows."
        }
    }

    static func color(for list: ShowList) -> Color {
        switch list {
        case .watching:    return .green
        case .waiting:     return .blue
        case .recommending: return .orange
        case .next:        return .purple
        }
    }
}
