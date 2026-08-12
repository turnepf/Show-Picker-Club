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
    // When the shows on screen were fetched. Non-nil only while we're showing
    // a cached copy that this launch hasn't managed to refresh yet.
    @State private var staleSince: Date?

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
                        // Only shown when this launch is still living off the
                        // cache — once the refresh lands the row disappears.
                        if let staleSince {
                            Text(Self.stalenessNote(since: staleSince))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .listRowBackground(Color.clear)
                        }
                    }
                }
            }
            .navigationTitle("Show Picker")
        }
        // Keyed on the cookie as well as the slug: the phone often hands off a
        // fresh session a beat after launch, and keying on the slug alone left
        // an expired-cookie failure on screen until the app was reopened.
        .task(id: auth.sessionToken) { await load() }
        // Coming back to the foreground refreshes in the background. It used to
        // reload only when the screen was empty; now that the cache means it
        // never is, that check would have made a wrist-raise show stale lists
        // forever. The refresh is silent — whatever is on screen stays.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active && !loading {
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

    // Stale-while-revalidate. The watch is slow to launch mostly because it is
    // slow to get a network up — watchOS brings the radio (or the phone's
    // Bluetooth proxy) online lazily, so the first request can take seconds or
    // fail outright and need a retry. Painting the cached lists first turns
    // that entire wait into a background refresh nobody watches.
    //
    // Right after launch the first request can fail even though the server is
    // fine, so transport failures still get a couple of retries before an error
    // is shown at all.
    private func load() async {
        guard let slug = auth.memberSlug else {
            shows = []
            staleSince = nil
            return
        }

        // Replay the last good response before touching the network. Only on a
        // blank screen — a refresh of already-visible lists must not flicker
        // back through older data on its way to newer.
        if shows.isEmpty, let cached = WatchCache.load(for: slug) {
            shows = cached.shows
            staleSince = cached.cachedAt
            errorText = nil
        }

        loading = true
        defer { loading = false }
        for attempt in 0...2 {
            do {
                let fresh = try await WatchAPI.shows(member: slug, cookie: auth.cookieHeader)
                shows = fresh
                WatchCache.save(fresh, for: slug)
                errorText = nil
                staleSince = nil
                return
            } catch {
                // .task(id:) restarts cancel the in-flight load — bail without
                // painting an error the replacement load will just clear.
                if error is CancellationError || Task.isCancelled { return }
                // A rejected session won't start working on the third try; the
                // phone has to hand off a new one. Retrying it just spent five
                // seconds to show the same message.
                if Self.isUnretryable(error) {
                    errorText = Self.message(for: error)
                    return
                }
                if attempt == 2 {
                    errorText = Self.message(for: error)
                    return
                }
                try? await Task.sleep(for: .seconds(Double(attempt + 1) * 1.5))
            }
        }
    }

    // 4xx is the server saying no, not the network being slow.
    private static func isUnretryable(_ error: Error) -> Bool {
        guard case .badResponse(let code)? = error as? WatchAPI.APIError else { return false }
        return (400..<500).contains(code)
    }

    private static func stalenessNote(since: Date) -> String {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return "Saved list · updated \(f.localizedString(for: since, relativeTo: Date()))"
    }

    private static func message(for error: Error) -> String {
        // The reads this app makes need a session, and the watch never signs
        // anyone in itself — a rejected cookie is fixed on the phone, so say so
        // rather than offering a Try Again that can't work.
        if case .badResponse(let code)? = error as? WatchAPI.APIError, code == 401 || code == 403 {
            return "Open Show Picker on your iPhone to refresh your sign-in."
        }
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
