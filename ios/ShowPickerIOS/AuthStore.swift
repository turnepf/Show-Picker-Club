import SwiftUI
import Combine
import WidgetKit

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
        // The Upcoming widget reads the App Group session we just wrote (or
        // cleared) — have it redraw against the new state.
        WidgetCenter.shared.reloadAllTimelines()
    }

    // How a login attempt resolved: a session was issued, or (self-enroll)
    // the server wants a name before creating the account.
    enum LoginResult { case success, needsName }

    @MainActor
    func loginWithEmail(email: String, code: String) async throws -> LoginResult {
        let r = try await API.loginWithEmail(email: email, code: code)
        if r.needsName == true { return .needsName }
        if r.success == true {
            await refresh()
            return .success
        }
        throw API.APIError.badResponse(401)
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
    func loginWithApple(identityToken: String, fullName: String? = nil) async throws -> LoginResult {
        let r = try await API.loginWithApple(identityToken: identityToken, fullName: fullName)
        if r.needsName == true { return .needsName }
        if r.success == true {
            await refresh()
            return .success
        }
        throw API.APIError.badResponse(401)
    }

    // Sign in with a passkey: fetch a challenge, let the device sign it, hand
    // the assertion back. No email or phone number is involved at any point —
    // the credential itself identifies the member.
    //
    // Throws PasskeyAuthenticator.Failure.canceled when the member dismisses
    // the system sheet, which callers treat as "nothing happened".
    @MainActor
    func loginWithPasskey() async throws {
        let options = try await API.passkeyBegin()
        let assertion = try await PasskeyAuthenticator().assert(challenge: options.challenge)
        let r = try await API.passkeyFinish(challenge: options.challenge,
                                            credentialID: assertion.credentialID,
                                            authenticatorData: assertion.authenticatorData,
                                            clientDataJSON: assertion.clientDataJSON,
                                            signature: assertion.signature)
        guard r.success == true else { throw API.APIError.badResponse(401) }
        await refresh()
    }

    // Add a passkey to the account this session already belongs to. A passkey
    // is never a way to sign up — it's added from inside a session, by someone
    // who has already proved the account is theirs.
    @MainActor
    func registerPasskey(label: String) async throws {
        let options = try await API.passkeyRegisterBegin()
        let credential = try await PasskeyAuthenticator().register(
            challenge: options.challenge,
            userName: options.user.name,
            userID: options.user.id)
        _ = try await API.passkeyRegisterFinish(challenge: options.challenge,
                                                credentialID: credential.credentialID,
                                                attestationObject: credential.attestationObject,
                                                clientDataJSON: credential.clientDataJSON,
                                                label: label)
    }

    // Finish an email self-enrollment (the /auth/login step answered
    // needsName). Creates the account and signs it in.
    @MainActor
    func enroll(email: String, code: String, fullName: String) async throws {
        let r = try await API.enroll(email: email, code: code, fullName: fullName)
        if r.success == true {
            await refresh()
        } else {
            throw API.APIError.badResponse(401)
        }
    }

    @MainActor
    func logout() async {
        await API.logout()
        clearLocalSession()
    }

    // Reset local state without hitting /auth/logout — used after account
    // deletion, where the server has already destroyed the session and
    // cleared the cookie in its response.
    @MainActor
    func clearLocalSession() {
        memberSlug = nil
        email = nil
        isAdmin = false
        SharedSession.clear()
        WatchBridge.shared.clear()
        // Drop cached reads, cached artwork, the widgets' last-good snapshots,
        // and any queued offline edits so the next person to sign in on this
        // device starts clean.
        OfflineQueue.shared.reset()
        OfflineCache.clearAll()
        ImageCache.shared.clearAll()
        WidgetSnapshotCache.clearAll()
        WidgetCenter.shared.reloadAllTimelines()
    }

    func isMe(_ slug: String) -> Bool { memberSlug == slug }
}
