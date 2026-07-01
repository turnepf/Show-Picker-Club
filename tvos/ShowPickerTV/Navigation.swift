import SwiftUI

// Navigation routes shared by every tab's stack. Detail carries minimal info
// for an instant header; the full record + cast are fetched by id.
enum Route: Hashable {
    case member(Member)
    case detail(id: Int, title: String, network: String?, rating: String?)
    // A recommendation ("Picks for you") has no backing show row yet — open the
    // detail from its title so the user can choose a list, rather than adding
    // it silently.
    case pick(title: String, network: String?, rating: String?, posterUrl: String?, networkUrl: String?)
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
            case .pick(let title, let network, let rating, let posterUrl, let networkUrl):
                ShowDetailView(id: nil, initialTitle: title, initialNetwork: network,
                               initialRating: rating, initialPoster: posterUrl, initialNetworkUrl: networkUrl)
            }
        }
    }
}
