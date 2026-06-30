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

    func loginWithEmail(email: String, code: String) async throws {
        let r = try await API.loginWithEmail(email: email, code: code)
        if r.success == true {
            await refresh()
        } else {
            throw API.APIError.badResponse(401)
        }
    }

    func loginWithPhone(phone: String, code: String) async throws {
        let r = try await API.loginWithPhone(phone: phone, code: code)
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
}
