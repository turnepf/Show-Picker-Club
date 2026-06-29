import Foundation

// Normalizes the text a streaming app hands the Share Extension into a clean
// show title plus a streaming service. Pure Foundation (no UIKit) so it can be
// unit-tested directly; ShareViewController owns the UIKit payload extraction
// and calls in here.
//
// Streaming apps wrap the title in marketing boilerplate, e.g.
//   Netflix     Check out "I Will Find You" on Netflix https://…
//   Paramount+  Hey! Thought you'd like The Amazing Race on Paramount+. Check it out…
//   HBO Max     Stream DTF St. Louis on HBO Max
//   Hulu        Check out Good Luck, Have Fun, Don't Die on Hulu! https://…?utm_source=…
// We strip the wrapper down to just the title; anything that isn't a recognized
// wrapper is left untouched so a plain title is never mangled.
enum ShareTitleParser {

    // Turn whatever a source app shared — a clean show name, an Apple TV URL, or a
    // marketing sentence — into a clean title plus a streaming service.
    static func parse(text: String?, url: URL?) -> (title: String?, network: String?) {
        // Network: the URL host is authoritative; otherwise look for an
        // "on <Service>" mention in the shared text (Netflix shares no URL object).
        let network = url.flatMap { networkFrom($0) }
            ?? text.flatMap { networkFromText($0) }

        // Title: clean up the shared text, falling back to the Apple TV URL slug.
        let title = text.flatMap { cleanTitle($0, network: network) }
            ?? url.flatMap { titleSlugFrom($0) }

        return (title?.nilIfEmpty, network)
    }

    // Reduce a shared text blob to just the show title. Plain, already-clean titles
    // (Apple TV, Safari page titles) pass through untouched; sentence-style shares
    // get their boilerplate, URL, and trailing "on <Network>" stripped off.
    static func cleanTitle(_ raw: String, network: String?) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)

        // A quoted span is the exact title in every Netflix-style share.
        if let quoted = firstQuoted(in: trimmed) { return quoted }

        // Only treat it as a marketing wrapper if it carries a URL or a leading
        // verb; otherwise it's already a bare title (which may legitimately contain
        // " on ", e.g. "Based on a True Story") and we leave it alone.
        let hasURL  = firstURL(in: trimmed) != nil
        let hasVerb = leadingVerb(of: trimmed) != nil
        guard hasURL || hasVerb else { return trimmed.nilIfEmpty }

        // Always drop a trailing/standalone share URL.
        var s = stripURLs(from: trimmed)

        // Strip the lead-in verb and a trailing "on <Network>" only when there's a
        // streaming context (a URL or a detected service). This protects plain
        // titles that happen to start with a verb, e.g. "Watch What Happens Live".
        if hasURL || network != nil {
            s = stripLeadingVerb(s)
            if network != nil,
               let r = s.range(of: " on ", options: [.backwards, .caseInsensitive]) {
                s = String(s[..<r.lowerBound])
            }
        }
        s = s.trimmingCharacters(in: titleTrimSet)
        return s.nilIfEmpty
    }

    // Characters to peel off the ends of a recovered title: whitespace, stray
    // quotes (straight + curly), and trailing punctuation. Note we never split on a
    // period, so "DTF St. Louis" keeps its internal "St.".
    private static let titleTrimSet = CharacterSet(charactersIn: " \t\n.,:;-—\"'\u{201C}\u{201D}\u{2018}\u{2019}")
        .union(.whitespacesAndNewlines)

    // The first double-quoted span (straight or curly quotes) — Netflix wraps the
    // exact show name in curly quotes: Check out "I Will Find You" on Netflix.
    private static func firstQuoted(in text: String) -> String? {
        let pattern = "[\"\u{201C}\u{201D}]([^\"\u{201C}\u{201D}]+)[\"\u{201C}\u{201D}]"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              let r = Range(match.range(at: 1), in: text) else { return nil }
        return String(text[r]).trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
    }

    // Strip every http(s) URL out of a text blob so links don't bleed into the title.
    private static func stripURLs(from text: String) -> String {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return text
        }
        var result = text
        let range = NSRange(text.startIndex..., in: text)
        // Remove from the end backwards so earlier match ranges stay valid.
        for match in detector.matches(in: text, options: [], range: range).reversed() {
            if let r = Range(match.range, in: result) { result.replaceSubrange(r, with: "") }
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Leading boilerplate streaming apps prepend to a share, written with straight
    // apostrophes (text is normalized before matching). Ordered longest-first so the
    // most specific prefix wins (e.g. "check this out" before "check out").
    private static let leadingVerbs = [
        "hey! thought you'd like", "hey, thought you'd like",
        "hey thought you'd like", "hey! i thought you'd like",
        "hey i thought you'd like", "i thought you'd like", "thought you'd like",
        "check this out:", "check this out", "check out:", "check out",
        "i'm watching", "now watching", "watching", "watch",
        "stream the", "stream:", "stream"
    ]

    // Lowercase + fold curly apostrophes to straight so prefixes match regardless
    // of how the source app typed them. One-for-one substitutions keep .count stable.
    private static func normalizedForMatch(_ text: String) -> String {
        text.lowercased()
            .replacingOccurrences(of: "\u{2019}", with: "'")
            .replacingOccurrences(of: "\u{2018}", with: "'")
    }

    private static func leadingVerb(of text: String) -> String? {
        let lower = normalizedForMatch(text)
        for verb in leadingVerbs where lower.hasPrefix(verb) {
            // Require a word boundary so titles like "Watchmen" aren't mistaken
            // for the verb "watch".
            let after = lower.dropFirst(verb.count).first
            if after == nil || after == " " || after == "\n" || after == "\t" || after == ":" {
                return verb
            }
        }
        return nil
    }

    private static func stripLeadingVerb(_ text: String) -> String {
        guard let verb = leadingVerb(of: text) else { return text }
        return String(text.dropFirst(verb.count)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // Detect the streaming service from an "on <Service>" mention in shared text,
    // for apps (Netflix) that hand us no URL object. Mirrors networkFrom(_:).
    private static func networkFromText(_ text: String) -> String? {
        let lower = text.lowercased()
        if lower.contains("netflix")                                 { return "Netflix"             }
        if lower.contains("apple tv")                                { return "Apple TV+"           }
        if lower.contains("hulu")                                    { return "Hulu"                }
        if lower.contains("disney")                                  { return "Disney+"             }
        if lower.contains("hbo max") || lower.contains("hbo")        { return "HBO Max"             }
        if lower.contains("peacock")                                 { return "Peacock"             }
        if lower.contains("paramount")                               { return "Paramount+"          }
        if lower.contains("prime video") || lower.contains("amazon") { return "Amazon Prime Video"  }
        if lower.contains("starz")                                   { return "Starz"               }
        if lower.contains("britbox")                                 { return "BritBox"             }
        return nil
    }

    // Pull the first http(s) URL out of a shared text blob. Apps like Netflix
    // share the link as text ("Watch X on Netflix https://…") instead of as a
    // discrete URL attachment.
    static func firstURL(in text: String) -> URL? {
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
        if host.contains("britbox")                            { return "BritBox"             }
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
