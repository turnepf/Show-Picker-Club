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
    case groupDetail(Int)
}

extension View {
    // Apply to each tab's NavigationStack so they all drill into the same
    // member and show-detail screens.
    func showDestinations() -> some View {
        navigationDestination(for: Route.self) { route in
            RouteScreen(route: route)
        }
    }
}

// Wraps every pushed screen so the remote's Menu/Back button pops it. By
// default, Menu from a pushed view inside a TabView reveals the tab bar
// without popping, which strands the user on the detail with no back path.
private struct RouteScreen: View {
    let route: Route
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            switch route {
            case .member(let m):
                MemberView(member: m)
            case .detail(let id, let title, let network, let rating):
                ShowDetailView(id: id, initialTitle: title, initialNetwork: network, initialRating: rating)
            case .pick(let title, let network, let rating, let posterUrl, let networkUrl):
                ShowDetailView(id: nil, initialTitle: title, initialNetwork: network,
                               initialRating: rating, initialPoster: posterUrl, initialNetworkUrl: networkUrl)
            case .groupDetail(let id):
                GroupDetailViewTV(groupId: id)
            }
        }
        .onExitCommand { dismiss() }
    }
}
