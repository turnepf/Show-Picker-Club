import Foundation

// The four lists a show can live on. rawValue is the stored/API value; `title`
// is the user-facing label (note "Awaiting", not "Waiting").
public enum ShowList: String, CaseIterable, Identifiable, Sendable {
    case watching, waiting, recommending, next

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .watching: return "Watching"
        case .waiting: return "Awaiting"
        case .recommending: return "Recommending"
        case .next: return "Up Next"
        }
    }
}
