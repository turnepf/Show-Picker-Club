import SwiftUI

// Navigation routes shared by every tab's stack. Detail carries minimal info
// for an instant header; the full record + cast are fetched by id.
enum Route: Hashable {
    case member(Member)
    case detail(id: Int, title: String, network: String?, rating: String?)
}

extension View {
    // Apply to each tab's NavigationStack so they all drill into the same
    // member and show-detail screens.
    func showDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            switch route {
            case .member(let m):
                MemberView(member: m)
            case .detail(let id, let title, let network, let rating):
                ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
            }
        }
    }
}
