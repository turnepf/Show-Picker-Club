import Foundation
import Combine

// Holds the network picker's contents and keeps them current.
//
// The list is served by GET /api/networks, so adding a network on the server
// reaches installed apps — that's the point of the endpoint. This is the piece
// that makes it invisible to the member: there is always a list to draw, from
// the moment the app launches, and it quietly gets better.
//
// Three layers, in the order they're consulted:
//   1. `NetworkCatalog.bundled` — the list as of this build, compiled in. A
//      brand-new install on a plane still has a picker.
//   2. UserDefaults — the last catalog the server sent. Read synchronously in
//      `init`, so the first Add Show of a session paints the current list
//      rather than the shipped one and then flickering. It lives here rather
//      than in OfflineCache because that gets wiped on logout, and the network
//      list isn't member data — there's nothing to protect and no reason to
//      re-download it because somebody signed out.
//   3. The network, once per app launch (and on a pull-to-refresh of the sheet
//      that uses it). A failure is a no-op: whatever is loaded stays.
//
// The rules about *what* to trust live in ShowPickerCore.NetworkCatalog, where
// Linux CI compiles and tests them.
//
// Isolation follows AuthStore: the type itself is not actor-bound (views read
// it straight from `body`, and `shared` is reachable from anywhere), and the
// two methods that mutate are @MainActor so the published change lands on the
// main thread.
final class NetworkCatalogStore: ObservableObject {
    static let shared = NetworkCatalogStore()

    let objectWillChange = ObservableObjectPublisher()

    private(set) var catalog: NetworkCatalog { willSet { objectWillChange.send() } }

    private static let defaultsKey = "networkCatalog.v1"
    // One fetch per launch is plenty for a list that changes a few times a
    // year; the endpoint is edge-cached for an hour anyway.
    private var fetched = false

    private init() {
        if let data = UserDefaults.standard.data(forKey: Self.defaultsKey),
           let cached = try? JSONDecoder().decode(NetworkCatalog.self, from: data) {
            catalog = NetworkCatalog.validated(cached)
        } else {
            catalog = .bundled
        }
    }

    var names: [String] { catalog.names }
    var sections: [NetworkCatalog.Section] { catalog.sections }
    func contains(_ name: String) -> Bool { catalog.contains(name) }

    /// Refresh from the server. Safe to call from every screen that shows a
    /// picker — it does the work once per launch.
    @MainActor
    func refreshIfNeeded() async {
        guard !fetched else { return }
        await refresh()
    }

    @MainActor
    func refresh() async {
        guard let fresh = try? await API.networks() else { return }
        fetched = true
        let validated = NetworkCatalog.validated(fresh)
        // A version we already have means no redraw and no write.
        guard validated.version != catalog.version || validated.names != catalog.names else { return }
        catalog = validated
        if let data = try? JSONEncoder().encode(validated) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}
