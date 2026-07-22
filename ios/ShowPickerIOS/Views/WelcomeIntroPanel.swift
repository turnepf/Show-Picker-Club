import SwiftUI

// "Welcome intro" — the message the operator sends a freshly approved
// member, mirroring the web /members intro panel: identical text, Copy and
// Text (SMS) actions. Collapsed by default so approved cards stay short;
// used by ManageMembersView (approved requests).
struct WelcomeIntroPanel: View {
    let slug: String
    // Greeting name — the server's editor_name (first name) when available.
    let displayName: String
    let phone: String?
    var defaultOpen = false

    @State private var expanded = false
    @State private var copied = false
    @Environment(\.openURL) private var openURL

    private var url: String { "https://showpicker.club/\(slug)" }

    // Kept word-for-word in sync with buildIntroPanel() in public/members.html.
    private var intro: String {
        """
        Hey \(displayName)! I set you up on Show Picker Club. It's a shared show tracker where we all keep track of what we're watching, what's next, and what we'd recommend. I seeded yours with some popular shows to get you started; if any don't interest you, just tap Edit, then Archive to remove them.

        Your list:
        \(url)

        To edit your list, tap Log in and we'll send a login code by text or email.

        You can also browse everyone else's lists from the home page:
        https://showpicker.club

        If you see something you like on someone else's list, tap the **+** to add it to yours!

        - Patrick
        """
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(intro)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            HStack(spacing: 16) {
                Button(copied ? "Copied!" : "Copy intro") {
                    UIPasteboard.general.string = intro
                    copied = true
                    Task {
                        try? await Task.sleep(nanoseconds: 1_500_000_000)
                        copied = false
                    }
                }
                if let phone, !phone.isEmpty,
                   let smsURL = URL(string: "sms:\(phone.filter { !$0.isWhitespace })&body=" +
                        (intro.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")) {
                    Button("Text intro") { openURL(smsURL) }
                }
            }
            .buttonStyle(.borderless)
            .font(.callout.weight(.semibold))
        } label: {
            HStack {
                Label("Welcome intro", systemImage: "envelope")
                Spacer()
                Text(url.replacingOccurrences(of: "https://", with: ""))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .onAppear { if defaultOpen { expanded = true } }
    }
}
