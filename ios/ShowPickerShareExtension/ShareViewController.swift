import UIKit
import SwiftUI
import UniformTypeIdentifiers

// Entry point for the Share Extension. Extracts the shared URL + show title from
// the system payload, hands them to ShareTitleParser for normalization, then
// presents ShareComposeView (SwiftUI) inside a hosting controller.
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

    // Pull title and network out of the NSExtensionItem the source app handed us,
    // then normalize via ShareTitleParser.
    private func extractSharedContent(completion: @escaping (String?, String?) -> Void) {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
            DispatchQueue.main.async { completion(nil, nil) }
            return
        }

        for item in items {
            // Many apps (Apple TV, Netflix) populate attributedTitle with the show
            // name; some (Netflix) instead drop a full sentence into the content text.
            let candidateTitle = item.attributedTitle?.string.nilIfEmpty
                ?? item.attributedContentText?.string.nilIfEmpty

            let providers = item.attachments ?? []

            // Preferred: a real URL attachment (Safari, Apple TV, most apps).
            if let provider = providers.first(where: {
                $0.hasItemConformingToTypeIdentifier(UTType.url.identifier)
            }) {
                provider.loadItem(forTypeIdentifier: UTType.url.identifier) { value, _ in
                    let parsed = ShareTitleParser.parse(text: candidateTitle,
                                                        url: value as? URL)
                    DispatchQueue.main.async { completion(parsed.title, parsed.network) }
                }
                return
            }

            // Fallback: some apps (e.g. Netflix) share the link inside plain text
            // rather than as a discrete URL attachment. Recover the URL from it so
            // the network still auto-detects, and mine the title out of the sentence.
            if let provider = providers.first(where: {
                $0.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
            }) {
                provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) { value, _ in
                    let text   = (value as? String).flatMap { $0.nilIfEmpty } ?? candidateTitle
                    let url    = text.flatMap { ShareTitleParser.firstURL(in: $0) }
                    let parsed = ShareTitleParser.parse(text: text, url: url)
                    DispatchQueue.main.async { completion(parsed.title, parsed.network) }
                }
                return
            }

            if candidateTitle != nil {
                let parsed = ShareTitleParser.parse(text: candidateTitle, url: nil)
                DispatchQueue.main.async { completion(parsed.title, parsed.network) }
                return
            }
        }
        DispatchQueue.main.async { completion(nil, nil) }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
