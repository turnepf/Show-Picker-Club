import Foundation
import Network
import Combine

// Tracks whether the device currently has a usable network path, using
// NWPathMonitor. Views observe `isOnline` to show the offline banner; the
// monitor also kicks the OfflineQueue to flush queued writes the moment the
// connection comes back.
@MainActor
final class Connectivity: ObservableObject {
    static let shared = Connectivity()

    @Published private(set) var isOnline = true

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "club.showpicker.connectivity")
    private var started = false

    private init() {}

    func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.setOnline(online) }
        }
        monitor.start(queue: queue)
    }

    private func setOnline(_ online: Bool) {
        let wasOffline = !isOnline
        isOnline = online
        // Coming back online: drain anything the user did while offline.
        if online && wasOffline {
            Task { await OfflineQueue.shared.flush() }
        }
    }
}
