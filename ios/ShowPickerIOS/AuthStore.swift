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

    // Whether refresh() has finished at least once. Until it has,
    // `memberSlug == nil` does not mean "nobody is signed in" — it means
    // nobody has asked yet. A universal link tapped on a cold launch arrives
    // while that is still true (the app's root .task and .onOpenURL race),
    // and treating it as logged-out asks a signed-in member to sign in again.
    private(set) var resolved = false { willSet { objectWillChange.send() } }

    @MainActor
    func refresh() async {
        // Two kinds of "not signed in", and only one of them is an answer.
        // checkAuthOrCached() returns the server's own verdict, or the cached
        // signed-in answer when offline; it throws when the server couldn't
        // be reached and nothing was cached. A thrown check is "don't know",
        // so it reads as signed out for now but clears nothing.
        let r: AuthCheckResponse
        var serverSaidSignedOut = false
        do {
            r = try await API.checkAuthOrCached()
            serverSaidSignedOut = !r.authenticated
        } catch {
            r = AuthCheckResponse(authenticated: false, email: nil, member: nil, isAdmin: nil)
        }
        // The server says this session is gone (expired, revoked, banned):
        // drop everything it left behind — the cookie, the offline queue,
        // cached owner memos — so none of it outlives the session or replays
        // under whoever signs in next. Only when there is something to drop:
        // a logged-out launch with nothing left over shouldn't wipe the
        // artwork cache every time.
        if serverSaidSignedOut && (memberSlug != nil || OfflineQueue.shared.hasLocalData
                                   || AuthStore.hasSessionCookies()) {
            clearLocalSession()
            resolved = true
            return
        }
        memberSlug = r.authenticated ? r.member : nil
        email = r.authenticated ? r.email : nil
        isAdmin = r.authenticated ? (r.isAdmin ?? false) : false
        OfflineQueue.shared.signedInMember = memberSlug
        if r.authenticated, let slug = memberSlug {
            SharedSession.sync(memberSlug: slug)
            WatchBridge.shared.send(memberSlug: slug, cookie: WatchBridge.currentCookieHeader())
        }
        resolved = true
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
    //
    // Also the second half of every logout, which is why the session cookie
    // is deleted here: whether or not /auth/logout got through (offline, a
    // server error), the device stops holding a working session.
    @MainActor
    func clearLocalSession() {
        memberSlug = nil
        email = nil
        isAdmin = false
        OfflineQueue.shared.signedInMember = nil
        AuthStore.deleteSessionCookies()
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

    // Every cookie stored for the API host, whatever its path or domain form.
    private static func apiHostCookies() -> [HTTPCookie] {
        guard let host = URL(string: API.baseString)?.host else { return [] }
        return (HTTPCookieStorage.shared.cookies ?? []).filter { cookie in
            let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
            return host == domain || host.hasSuffix("." + domain)
        }
    }

    static func hasSessionCookies() -> Bool { !apiHostCookies().isEmpty }

    static func deleteSessionCookies() {
        apiHostCookies().forEach(HTTPCookieStorage.shared.deleteCookie)
    }

    func isMe(_ slug: String) -> Bool { memberSlug == slug }
}
