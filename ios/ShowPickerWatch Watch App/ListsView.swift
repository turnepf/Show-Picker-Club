import SwiftUI
import ShowPickerCore

// Screen 1: the four lists, each with a count. Tapping one drills into its
// shows. Loads your shows once (public read) and filters per list.
struct ListsView: View {
    @EnvironmentObject private var auth: WatchAuth
    @Environment(\.scenePhase) private var scenePhase
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
                    VStack(spacing: 10) {
                        Text(errorText).font(.footnote).foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                        Button("Try Again") { Task { await load() } }
                            .font(.footnote)
                    }
                    .padding(.horizontal)
                } else {
                    List {
                        Section("Your Lists") {
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

                        Section("Groups") {
                            NavigationLink("Browse Groups") {
                                GroupsWatchView()
                            }
                        }
                    }
                }
            }
            .navigationTitle("Show Picker")
        }
        .task(id: auth.memberSlug) { await load() }
        // Coming back to the foreground with nothing on screen (the usual
        // "close and reopen" recovery) — just reload instead of making the
        // user do it.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && shows.isEmpty && !loading {
                Task { await load() }
            }
        }
    }

    private var signInPrompt: some View {
        VStack(spacing: 8) {
            Image(systemName: "iphone").font(.title2).foregroundStyle(.secondary)
            Text("Open Show Picker on your iPhone and sign in.")
                .font(.footnote).multilineTextAlignment(.center)
        }
        .padding()
    }

    // Right after launch the watch often hasn't finished bringing up
    // networking (Wi-Fi or the phone's Bluetooth proxy), so the first
    // request can fail even though the server is fine — retry a couple of
    // times before showing an error at all.
    private func load() async {
        guard let slug = auth.memberSlug else { shows = []; return }
        loading = true
        defer { loading = false }
        for attempt in 0...2 {
            do {
                shows = try await WatchAPI.shows(member: slug, cookie: auth.cookieHeader)
                errorText = nil
                return
            } catch {
                // .task(id:) restarts cancel the in-flight load — bail without
                // painting an error the replacement load will just clear.
                if error is CancellationError || Task.isCancelled { return }
                if attempt == 2 {
                    errorText = Self.message(for: error)
                    return
                }
                try? await Task.sleep(for: .seconds(Double(attempt + 1) * 1.5))
            }
        }
    }

    private static func message(for error: Error) -> String {
        if let urlError = error as? URLError {
            switch urlError.code {
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed:
                return "Your watch is offline. Your shows will load once it reconnects."
            case .timedOut, .cannotConnectToHost, .cannotFindHost:
                return "Show Picker isn't responding. It's not you — try again in a moment."
            default:
                break
            }
        }
        return "Couldn't load your shows. Tap Try Again in a moment."
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
