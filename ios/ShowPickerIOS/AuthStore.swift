import SwiftUI
import Combine

// Observable session state. URLSession.shared handles the cookie itself —
// we just track who's logged in and which member they are so views can
// branch on it.
final class AuthStore: ObservableObject {
    let objectWillChange = ObservableObjectPublisher()

    var memberSlug: String? { willSet { objectWillChange.send() } }
    var email: String? { willSet { objectWillChange.send() } }
    var isAdmin: Bool = false { willSet { objectWillChange.send() } }

    var isLoggedIn: Bool { memberSlug != nil }

    @MainActor
    func refresh() async {
        let r = await API.checkAuth()
        memberSlug = r.authenticated ? r.member : nil
        email = r.authenticated ? r.email : nil
        isAdmin = r.authenticated ? (r.isAdmin ?? false) : false
        if r.authenticated, let slug = memberSlug {
            SharedSession.sync(memberSlug: slug)
            WatchBridge.shared.send(memberSlug: slug, cookie: WatchBridge.currentCookieHeader())
        }
    }

    @MainActor
    func loginWithEmail(email: String, code: String) async throws {
        let r = try await API.loginWithEmail(email: email, code: code)
        if r.success == true {
            await refresh()
        } else {
            throw API.APIError.badResponse(401)
        }
    }

    @MainActor
    func loginWithPhone(phone: String, code: String) async throws {
        let r = try await API.loginWithPhone(phone: phone, code: code)
        if r.success == true {
            await refresh()
        } else {
            throw API.APIError.badResponse(401)
        }
    }

    @MainActor
    func loginWithApple(identityToken: String) async throws {
        let r = try await API.loginWithApple(identityToken: identityToken)
        if r.success == true {
            await refresh()
        } else {
            throw API.APIError.badResponse(401)
        }
    }

    @MainActor
    func logout() async {
        await API.logout()
        memberSlug = nil
        email = nil
        isAdmin = false
        SharedSession.clear()
        WatchBridge.shared.clear()
        // Drop cached reads and any queued offline edits so the next person to
        // sign in on this device starts clean.
        OfflineQueue.shared.reset()
        OfflineCache.clearAll()
    }

    func isMe(_ slug: String) -> Bool { memberSlug == slug }
}
