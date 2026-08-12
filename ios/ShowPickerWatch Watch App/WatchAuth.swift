import Foundation
import Combine
import WatchConnectivity
import ShowPickerCore


// Receives the session (member slug + cookie header) handed off from the
// paired iPhone. Reads are public (GET /api/shows?member=…), so the slug alone
// is enough to show your lists; the cookie is kept for any future writes.
final class WatchAuth: NSObject, ObservableObject, WCSessionDelegate {
    @Published var memberSlug: String?
    @Published var cookieHeader: String?

    override init() {
        super.init()
        // Cached from a previous hand-off, so the watch works at launch
        // before the phone re-sends.
        memberSlug = WatchShared.memberSlug
        cookieHeader = WatchShared.cookieHeader
        if WCSession.isSupported() {
            WCSession.default.delegate = self
            WCSession.default.activate()
        }
    }

    var isLoggedIn: Bool { (memberSlug?.isEmpty == false) }

    // Identity of the current session, for `.task(id:)`. The cookie is part of
    // it on purpose: the phone commonly hands off a fresh session a moment
    // after launch, and a view keyed on the slug alone would never re-run its
    // load when only the cookie changed.
    var sessionToken: String { "\(memberSlug ?? "")|\(cookieHeader ?? "")" }

    private func apply(_ ctx: [String: Any]) {
        let slug = ctx["member"] as? String
        let cookie = ctx["cookie"] as? String
        DispatchQueue.main.async {
            let previousSlug = self.memberSlug
            self.memberSlug = (slug?.isEmpty == false) ? slug : nil
            self.cookieHeader = (cookie?.isEmpty == false) ? cookie : nil
            // Persist for the next cold launch.
            WatchShared.memberSlug = self.memberSlug
            WatchShared.cookieHeader = self.cookieHeader
            // Signing out — or switching to a different member — has to take
            // the cached lists with it, or the next cold launch paints
            // somebody else's shows before the refresh corrects it.
            if self.memberSlug == nil || self.memberSlug != previousSlug {
                WatchCache.clear()
            }
        }
    }

    // Ask the phone for the current session, if it's reachable right now.
    private func requestLiveSession(_ session: WCSession) {
        guard session.isReachable else { return }
        session.sendMessage(["request": "session"], replyHandler: { [weak self] reply in
            self?.apply(reply)
        }, errorHandler: { _ in })
    }

    // MARK: WCSessionDelegate
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        // Only apply a context the phone has actually sent. An empty dictionary
        // means "nothing handed off yet" — applying it would wipe the session
        // we just restored from the cache in init(). An explicit sign-out
        // arrives as ["member": "", …] (keys present) and still clears.
        if !session.receivedApplicationContext.isEmpty {
            apply(session.receivedApplicationContext)
        }
        requestLiveSession(session)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        apply(applicationContext)
    }

    // The phone came within reach after launch (e.g. its app was just opened) —
    // pull the session live instead of waiting for the next hand-off.
    func sessionReachabilityDidChange(_ session: WCSession) {
        requestLiveSession(session)
    }
}
