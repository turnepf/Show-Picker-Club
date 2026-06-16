import SwiftUI

// Easter egg: shake the phone and we pull a random title from your own Up Next
// and tell you to watch it next, with its full detail card below the banner.
struct ShakePickView: View {
    let show: Show
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ShowDetailView(id: show.id, initialTitle: show.title,
                           initialNetwork: show.network, initialRating: show.rating)
                .environmentObject(auth)
                .safeAreaInset(edge: .top) {
                    VStack(spacing: 2) {
                        Text("🎬 Watch this show next")
                            .font(.headline)
                        Text("Shaken from your Up Next list.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(.thinMaterial)
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { dismiss() }
                    }
                }
        }
    }
}
