import SwiftUI

// Thin status strip shown under the header when the device is offline or there
// are edits waiting to sync. Silent when online with nothing pending.
struct OfflineBanner: View {
    @ObservedObject private var connectivity = Connectivity.shared
    @ObservedObject private var queue = OfflineQueue.shared

    var body: some View {
        if let text = bannerText {
            HStack(spacing: 8) {
                Image(systemName: icon)
                Text(text)
                    .font(.caption.weight(.medium))
                Spacer()
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity)
            .background(connectivity.isOnline ? Color.orange.opacity(0.18) : Color.secondary.opacity(0.18))
            .foregroundStyle(connectivity.isOnline ? Color.orange : Color.secondary)
        }
    }

    private var pending: Int { queue.pendingCount }

    private var bannerText: String? {
        if !connectivity.isOnline {
            return pending == 0
                ? "Offline — showing saved shows"
                : "Offline — \(pending) change\(pending == 1 ? "" : "s") will sync when you reconnect"
        }
        if queue.isFlushing && pending > 0 {
            return "Syncing \(pending) change\(pending == 1 ? "" : "s")…"
        }
        if pending > 0 {
            return "\(pending) change\(pending == 1 ? "" : "s") waiting to sync"
        }
        return nil
    }

    private var icon: String {
        connectivity.isOnline ? "arrow.triangle.2.circlepath" : "wifi.slash"
    }
}
