import SwiftUI
import Combine

// Observable session state. URLSession.shared handles the cookie itself —
// we just track who's logged in and which member they are so views can
// branch on it.
final class AuthStore: ObservableObject {
    let objectWillChange = ObservableObjectPublisher()

    var memberSlug: String? { willSet { objectWillChange.send() } }
    var email: String? { willSet { objectWillChange.send() } }

    var isLoggedIn: Bool { memberSlug != nil }

    @MainActor
    func refresh() async {
        let r = await API.checkAuth()
        memberSlug = r.authenticated ? r.member : nil
        email = r.authenticated ? r.email : nil
    }

    @MainActor
    func login(member slug: String, code: String) async throws {
        let r = try await API.login(member: slug, code: code)
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
    }

    func isMe(_ slug: String) -> Bool { memberSlug == slug }
}
