import Foundation
import Combine
import WatchConnectivity
import WidgetKit
import ShowPickerCore


// Receives the session (member slug + cookie header) handed off from the
// paired iPhone. Reads are public (GET /api/shows?member=…), so the slug alone
// is enough to show your lists; the cookie is kept for any future writes.
final class WatchAuth: NSObject, ObservableObject, WCSessionDelegate {
    @Published var memberSlug: String?
    @Published var cookieHeader: String?

    override init() {
        super.init()
        // Cached from a previous hand-off (in the shared App Group, which the
        // complication also reads), so the watch works at launch before the
        // phone re-sends.
        memberSlug = WatchShared.memberSlug
        cookieHeader = WatchShared.cookieHeader
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    var isLoggedIn: Bool { (memberSlug?.isEmpty == false) }

    private func apply(_ ctx: [String: Any]) {
        let slug = ctx["member"] as? String
        let cookie = ctx["cookie"] as? String
        DispatchQueue.main.async {
            self.memberSlug = (slug?.isEmpty == false) ? slug : nil
            self.cookieHeader = (cookie?.isEmpty == false) ? cookie : nil
            // Persist to the shared App Group so the complication's timeline
            // provider can fetch your shows, then nudge it to refresh.
            WatchShared.memberSlug = self.memberSlug
            WatchShared.cookieHeader = self.cookieHeader
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    // MARK: WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        apply(session.receivedApplicationContext)
        if session.isReachable {
            session.sendMessage(["request": "session"], replyHandler: { [weak self] reply in
                self?.apply(reply)
            }, errorHandler: { _ in })
        }
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }
}
