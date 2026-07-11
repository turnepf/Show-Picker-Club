import SwiftUI
import Combine

// Observable session state for tvOS. URLSession.shared persists the session
// cookie itself — we just track who's signed in so the app can gate the
// member lists behind login (and so every visit registers as a "tvos" session
// in the reporting dashboard's platform breakdown).
@MainActor
final class AuthStore: ObservableObject {
    @Published var memberSlug: String?
    @Published var email: String?
    @Published var isAdmin: Bool = false
    // nil until the first auth check finishes, so the UI can show a splash
    // instead of flashing the login screen on launch.
    @Published var checked: Bool = false

    var isLoggedIn: Bool { memberSlug != nil }

    func refresh() async {
        let r = await API.checkAuth()
        memberSlug = r.authenticated ? r.member : nil
        email = r.authenticated ? r.email : nil
        isAdmin = r.authenticated ? (r.isAdmin ?? false) : false
        checked = true
    }

    // How a login attempt resolved: a session was issued, or (self-enroll)
    // the server wants a name before creating the account.
    enum LoginResult { case success, needsName }

    @discardableResult
    func loginWithEmail(email: String, code: String) async throws -> LoginResult {
        let r = try await API.loginWithEmail(email: email, code: code)
        if r.needsName == true { return .needsName }
        if r.success == true {
            await refresh()
            return .success
        }
        throw API.APIError.badResponse(401)
    }

    func loginWithPhone(phone: String, code: String) async throws {
        let r = try await API.loginWithPhone(phone: phone, code: code)
        if r.success == true {
            await refresh()
        } else {
            throw API.APIError.badResponse(401)
        }
    }

    func loginWithApple(identityToken: String, fullName: String? = nil) async throws -> LoginResult {
        let r = try await API.loginWithApple(identityToken: identityToken, fullName: fullName)
        if r.needsName == true { return .needsName }
        if r.success == true {
            await refresh()
            return .success
        }
        throw API.APIError.badResponse(401)
    }

    // Finish an email self-enrollment (the /auth/login step answered
    // needsName). Creates the account and signs it in.
    func enroll(email: String, code: String, fullName: String) async throws {
        let r = try await API.enroll(email: email, code: code, fullName: fullName)
        if r.success == true {
            await refresh()
        } else {
            throw API.APIError.badResponse(401)
        }
    }

    func logout() async {
        await API.logout()
        memberSlug = nil
        email = nil
        isAdmin = false
    }

    // Drop local state after the server already destroyed the session
    // (account deletion) — no logout round-trip needed.
    func clearLocalSession() {
        memberSlug = nil
        email = nil
        isAdmin = false
    }
}
