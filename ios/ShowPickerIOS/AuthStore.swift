import SwiftUI

// Observable session state. URLSession.shared handles the cookie itself —
// we just track who's logged in and which member they are so views can
// branch on it.
@MainActor
final class AuthStore: ObservableObject {
    @Published var memberSlug: String?
    @Published var email: String?

    var isLoggedIn: Bool { memberSlug != nil }

    func refresh() async {
        let r = await API.checkAuth()
        memberSlug = r.authenticated ? r.member : nil
        email = r.authenticated ? r.email : nil
    }

    func login(member slug: String, code: String) async throws {
        let r = try await API.login(member: slug, code: code)
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
    }

    func isMe(_ slug: String) -> Bool { memberSlug == slug }
}
