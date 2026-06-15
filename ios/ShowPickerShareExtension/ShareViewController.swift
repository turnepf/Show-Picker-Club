import UIKit
import SwiftUI
import UniformTypeIdentifiers

// Entry point for the Share Extension. Extracts the shared URL + show title,
// then presents ShareComposeView (SwiftUI) inside a hosting controller.
class ShareViewController: UIViewController {

    override func viewDidLoad() {
        super.viewDidLoad()
        extractSharedContent { [weak self] title, network in
            guard let self else { return }
            let compose = ShareComposeView(
                suggestedTitle:   title   ?? "",
                suggestedNetwork: network,
                onComplete: { [weak self] in
                    self?.extensionContext?.completeRequest(returningItems: nil)
                },
                onCancel: { [weak self] in
                    self?.extensionContext?.cancelRequest(withError: CancellationError())
                }
            )
            let host = UIHostingController(rootView: compose)
            self.addChild(host)
            host.view.frame = self.view.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            self.view.addSubview(host.view)
            host.didMove(toParent: self)
        }
    }

    // Pull title and network out of the NSExtensionItem the source app handed us.
    private func extractSharedContent(completion: @escaping (String?, String?) -> Void) {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            DispatchQueue.main.async { completion(nil, nil) }
            return
        }

        for item in items {
            // Many apps (Apple TV, Netflix) populate attributedTitle with the show name.
            let candidateTitle = item.attributedTitle?.string.nilIfEmpty
                ?? item.attributedContentText?.string.nilIfEmpty

            let providers = item.attachments ?? []

            // Preferred: a real URL attachment (Safari, Apple TV, most apps).
            if let provider = providers.first(where: {
                $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
            }) {
                provider.loadItem(forTypeIdentifier: UTType.url.identifier) { value, _ in
                    let url     = value as? URL
                    let network = url.flatMap { Self.networkFrom($0) }
                    // For Apple TV URLs the title slug is in the path; use it only
                    // when the app didn't supply an explicit title.
                    let title   = candidateTitle ?? url.flatMap { Self.titleSlugFrom($0) }
                    DispatchQueue.main.async { completion(title, network) }
                }
                return
            }

            // Fallback: some apps (e.g. Netflix) share the link inside plain text
            // rather than as a discrete URL attachment. Recover the URL from it so
            // the network still auto-detects.
            if let provider = providers.first(where: {
                $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
            }) {
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { value, _ in
                    let text    = (value as? String) ?? candidateTitle
                    let url     = text.flatMap { Self.firstURL(in: $0) }
                    let network = url.flatMap { Self.networkFrom($0) }
                    let title   = candidateTitle ?? url.flatMap { Self.titleSlugFrom($0) }
                    DispatchQueue.main.async { completion(title, network) }
                }
                return
            }

            if candidateTitle != nil {
                DispatchQueue.main.async { completion(candidateTitle, nil) }
                return
            }
        }
        DispatchQueue.main.async { completion(nil, nil) }
    }

    // Pull the first http(s) URL out of a shared text blob. Apps like Netflix
    // share the link as text ("Watch X on Netflix https://…") instead of as a
    // discrete URL attachment.
    private static func firstURL(in text: String) -> URL? {
        let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
        let range = NSRange(text.startIndex..., in: text)
        guard let url = detector?.firstMatch(in: text, options: [], range: range)?.url,
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
    }

    // Map the share URL's hostname to one of the app's canonical network names.
    private static func networkFrom(_ url: URL) -> String? {
        let host = url.host ?? ""
        if host.contains("netflix")                            { return "Netflix"             }
        if host == "tv.apple.com"                              { return "Apple TV+"            }
        if host.contains("hulu")                               { return "Hulu"                }
        if host.contains("disneyplus")                         { return "Disney+"             }
        if host.contains("max.com") || host.contains("hbomax") { return "HBO Max"            }
        if host.contains("peacock")                            { return "Peacock"             }
        if host.contains("paramount")                          { return "Paramount+"          }
        if host.contains("amazon") || host.contains("primevideo") { return "Amazon Prime Video" }
        if host.contains("starz")                              { return "Starz"               }
        if host.contains("amc.")                               { return "AMC+"                }
        return nil
    }

    // Apple TV URLs follow the pattern tv.apple.com/*/show/the-show-name/id.
    // Extract and title-case the slug when the app didn't supply a title.
    private static func titleSlugFrom(_ url: URL) -> String? {
        guard (url.host ?? "").contains("apple.com") else { return nil }
        let parts = url.pathComponents
        guard let idx = parts.firstIndex(where: { $0 == "show" || $0 == "movie" }),
              idx + 1 < parts.count else { return nil }
        return parts[idx + 1]
            .split(separator: "-")
            .map(\.capitalized)
            .joined(separator: " ")
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
