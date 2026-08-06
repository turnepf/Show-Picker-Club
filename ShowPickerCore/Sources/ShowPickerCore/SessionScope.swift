import Foundation

/// UI state that exists only because someone is signed in — whose lists are in
/// focus, who they share groups with, how many of their shows are unrated.
///
/// It lives here, outside the views, because of a specific regression. In
/// 2026-08 the iPad and Mac sidebar kept drawing a signed-in nav *after*
/// logout: it still named a focused member above their four lists, and still
/// listed the roster with each member's show count. Every row 401'd on tap.
/// The cause was that each view held this state as its own `@State`, which
/// `AuthStore` has no way to reach — clearing the session cleared the session,
/// not the screen.
///
/// Two properties of this type make that class of bug hard to reintroduce, and
/// they fail independently:
///
/// 1. `clear()` reassigns the whole value rather than nilling fields one by
///    one, so a property added later is cleared by construction. There is no
///    per-field list anybody can forget to update.
/// 2. `visibleMemberSlugs(mySlug:)` answers "nobody" whenever there is no
///    signed-in member — so a roster stays hidden even if a caller forgets to
///    call `clear()` at all. That second rule is what would have kept the
///    member list off the logged-out Mac window.
///
/// Deliberately UI-free and Foundation-only so it builds and tests on Linux CI
/// (`swift test`) rather than needing a macOS runner.
public struct SessionScope: Equatable, Sendable {

    /// Whose lists a sidebar is showing. `nil` means nobody is in focus.
    public var focusedSlug: String?

    /// Slugs of members sharing at least one group with the signed-in member.
    /// Empty is the honest answer for someone in no groups — and for someone
    /// signed out.
    public var groupMemberSlugs: Set<String>

    /// Unrated shows on the signed-in member's lists; drives the nav badge.
    public var backlogCount: Int

    public init(focusedSlug: String? = nil,
                groupMemberSlugs: Set<String> = [],
                backlogCount: Int = 0) {
        self.focusedSlug = focusedSlug
        self.groupMemberSlugs = groupMemberSlugs
        self.backlogCount = backlogCount
    }

    /// Drop everything derived from the session. Call this on logout.
    ///
    /// Assigning a fresh value is the point: a field added to this type later
    /// is covered without anyone remembering to extend this method.
    public mutating func clear() {
        self = SessionScope()
    }

    /// True when nothing here still describes a signed-in member.
    public var isEmpty: Bool { self == SessionScope() }

    /// Which members a roster UI may list, given who is signed in.
    ///
    /// Signed out (`mySlug == nil`) the answer is nobody, whatever this value
    /// still happens to hold. That makes the visibility rule independent of
    /// whether teardown ran.
    public func visibleMemberSlugs(mySlug: String?) -> Set<String> {
        guard let mySlug else { return [] }
        return groupMemberSlugs.union([mySlug])
    }
}
