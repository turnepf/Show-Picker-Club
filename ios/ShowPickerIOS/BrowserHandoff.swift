import UIKit

// Sends a showpicker.club link the app can't render back to the browser.
//
// The website's own pages (the AI-app sign-in above all) are excluded from
// the app's universal links, but a device keeps an old copy of that list for
// a while, and until it refreshes it hands those URLs to the app. Dropping
// them is what made "Connect Claude" open Show Picker and stop. The system
// opens an app's own universal link in the browser rather than looping back
// to the app, but a device can't be relied on to agree — so a link that
// bounces straight back is copied instead, with a sentence saying where to
// paste it, rather than being opened again.
@MainActor
enum BrowserHandoff {
    private static var lastURL: URL?
    private static var lastAt = Date.distantPast

    static func open(_ url: URL) {
        if url == lastURL, Date().timeIntervalSince(lastAt) < 10 {
            UIPasteboard.general.url = url
            ErrorCenter.shared.explain("That page opens in your web browser. The link is copied — paste it into Safari’s address bar.")
            return
        }
        lastURL = url
        lastAt = Date()
        UIApplication.shared.open(url)
    }
}
