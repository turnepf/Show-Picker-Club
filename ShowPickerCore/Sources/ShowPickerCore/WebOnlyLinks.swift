import Foundation

// The showpicker.club paths the website owns and the app has no screen for —
// the exclusions in public/.well-known/apple-app-site-association, mirrored
// here so the app can recognise one when it arrives anyway and hand it back
// to the browser.
//
// It arrives anyway because devices cache the association file. When a path
// is newly excluded (the AI-app sign-in, /oauth/*, was added after the app
// shipped), a phone or Mac holding the old copy keeps opening that URL in the
// app for as long as the cache lives — and the app used to drop anything it
// couldn't route, so connecting Claude opened Show Picker and nothing
// happened. check-static.sh fails the PR if this list and the file disagree.
public enum WebOnlyLinks {
    // AASA pattern syntax: "/x/*" is everything under /x/, "/x*" is any path
    // starting with /x, and a bare "/x" is that path exactly.
    public static let patterns: [String] = [
        "/api/*",
        "/auth/*",
        "/calendar/*",
        "/oauth/*",
        "/mcp",
        "/connect",
        "/connected-apps",
        "/.well-known/*",
        "/admin*",
        "/members*",
        "/reporting*",
        "/url-cleanup*",
        "/vibe-admin*",
        "/vibe*",
        "/subscriptions*",
        "/sms*",
        "/join*",
        "/setup*",
        "/privacy*",
        "/terms*",
        "/requests*",
    ]

    public static func isWebOnly(_ url: URL) -> Bool {
        let path = url.path.isEmpty ? "/" : url.path
        return patterns.contains { matches(path, $0) }
    }

    static func matches(_ path: String, _ pattern: String) -> Bool {
        if pattern.hasSuffix("/*") {
            let base = String(pattern.dropLast(2))
            return path == base || path.hasPrefix(base + "/")
        }
        if pattern.hasSuffix("*") {
            return path.hasPrefix(String(pattern.dropLast()))
        }
        return path == pattern || path == pattern + "/"
    }
}
