import Foundation
import WatchConnectivity

// Pushes the logged-in session (member slug + cookie header) to the paired
// Apple Watch via WatchConnectivity, so the watch app can show your lists
// without its own login. App Groups don't cross to watchOS, so this is the
// bridge (SharedSession handles the on-device Share Extension separately).
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private override init() {
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    // Touch this once at launch so the session activates early.
    func start() {}

    // Push the current session to the watch (empty strings = signed out).
    func send(memberSlug: String?, cookie: String?) {
        guard WCSession.isSupported() else { return }
        let ctx: [String: Any] = [
            "member": memberSlug ?? "",
            "cookie": cookie ?? "",
        ]
        try? WCSession.default.updateApplicationContext(ctx)
    }

    func clear() { send(memberSlug: nil, cookie: nil) }

    // Current "session=…" Cookie header for showpicker.club, if signed in.
    static func currentCookieHeader() -> String? {
        guard let url = URL(string: "https://showpicker.club"),
              let cookies = HTTPCookieStorage.shared.cookies(for: url), !cookies.isEmpty else { return nil }
        return HTTPCookie.requestHeaderFields(with: cookies)["Cookie"]
    }

    // MARK: WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { WCSession.default.activate() }

    // The watch asks for the current session when it launches — answer live.
    func session(_ session: WCSession, didReceiveMessage message: [String: Any],
                 replyHandler: @escaping ([String: Any]) -> Void) {
        replyHandler([
            "member": SharedSession.memberSlug ?? "",
            "cookie": SharedSession.cookieHeader ?? WatchBridge.currentCookieHeader() ?? "",
        ])
    }
}
