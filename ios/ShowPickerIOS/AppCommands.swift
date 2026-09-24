import SwiftUI

// Menu-bar commands for Mac Catalyst (and iPad hardware keyboards). The menu
// lives on the App scene, far from the views that own the search sheet and
// load state, so commands are relayed as notifications; HomeView/IPadHomeView
// listen with an async for-await loop.
extension Notification.Name {
    static let showSearchCommand = Notification.Name("net.patrickturner.showpicker.showSearch")
    static let refreshCommand = Notification.Name("net.patrickturner.showpicker.refresh")
}

struct AppCommands: Commands {
    var body: some Commands {
        // Slot the app's actions after File > New, the conventional spot.
        CommandGroup(after: .newItem) {
            Button("Find a Show…") {
                NotificationCenter.default.post(name: .showSearchCommand, object: nil)
            }
            .keyboardShortcut("f", modifiers: .command)

            Button("Refresh") {
                NotificationCenter.default.post(name: .refreshCommand, object: nil)
            }
            .keyboardShortcut("r", modifiers: .command)
        }
    }
}

extension View {
    // Run `action` every time `name` is posted, for as long as the view is
    // alive. Async-sequence flavor of the old NotificationCenter publisher.
    func onAppCommand(_ name: Notification.Name, perform action: @escaping @MainActor () -> Void) -> some View {
        task {
            for await _ in NotificationCenter.default.notifications(named: name).map({ _ in () }) {
                action()
            }
        }
    }
}
