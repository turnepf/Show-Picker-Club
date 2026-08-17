import Foundation
import Combine

// Holds the network picker's contents and keeps them current.
//
// The list is served by GET /api/networks, so adding a network on the server
// reaches installed apps — that's the point of the endpoint. This is the piece
// that makes it invisible to the member: there is always a list to draw, from
// the moment the app launches, and it quietly gets better.
//
// Always try the server; fall back to what's already loaded.
//
// The cache exists for the pull that *fails*, not as a reason to skip one — so
// `refresh()` runs every time a picker appears and every time the app comes
// back to the foreground, not once per launch. An app can stay resident for
// days, and "you added Stan last Tuesday but this phone hasn't asked since
// Monday" is the exact failure the endpoint was built to end. Repeat pulls are
// nearly free: the catalog version is an ETag, so an unchanged list comes back
// 304 with no body.
//
// What's drawn while that request is in flight, in the order consulted:
//   1. UserDefaults — the last catalog the server sent, read synchronously in
//      `init`, so the first Add Show of a session paints the current list
//      rather than the shipped one and then flickering. It lives here rather
//      than in OfflineCache because that gets wiped on logout, and the network
//      list isn't member data — there's nothing to protect and no reason to
//      re-download it because somebody signed out.
//   2. `NetworkCatalog.bundled` — the list as of this build, compiled in, for
//      a brand-new install that has never reached the server.
//
// A failed pull is a no-op: whatever is loaded stays, and the next picker
// tries again.
//
// The rules about *what* to trust live in ShowPickerCore.NetworkCatalog, where
// Linux CI compiles and tests them.
//
// Isolation follows AuthStore: the type itself is not actor-bound (views read
// it straight from `body`, and `shared` is reachable from anywhere), and the
// one method that mutates is @MainActor so the published change lands on the
// main thread.
final class NetworkCatalogStore: ObservableObject {
    static let shared = NetworkCatalogStore()

    let objectWillChange = ObservableObjectPublisher()

    private(set) var catalog: NetworkCatalog { willSet { objectWillChange.send() } }

    private static let defaultsKey = "networkCatalog.v1"
    // Coalesces callers that land together — the sheet's .task and a
    // foreground notification can fire in the same frame. It never suppresses
    // a *later* pull, which is the difference between "don't ask twice at
    // once" and the once-per-launch rule this replaced.
    private var refreshing = false

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

    /// Pull the current list. Call it from anywhere a picker is about to be
    /// seen — that's the point, and a request that changes nothing is a 304.
    ///
    /// Never throws and never clears: a failure leaves the loaded list exactly
    /// where it was, so being offline costs a member nothing they'd notice.
    @MainActor
    func refresh() async {
        guard !refreshing else { return }
        refreshing = true
        defer { refreshing = false }

        guard let fresh = try? await API.networks() else { return }
        let validated = NetworkCatalog.validated(fresh)
        // Unchanged means no redraw and no write — the common case, since most
        // pulls are confirming a list that hasn't moved in months.
        guard validated.version != catalog.version || validated.names != catalog.names else { return }
        catalog = validated
        if let data = try? JSONEncoder().encode(validated) {
            UserDefaults.standard.set(data, forKey: Self.defaultsKey)
        }
    }
}
