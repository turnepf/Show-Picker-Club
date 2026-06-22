import Foundation

// One write the user made while offline, persisted until it can be replayed
// against the live API. Covers the show edits the app lets you make on your
// own lists: add, edit, move between lists, archive, delete.
//
// `showId` is the real database id for edits, or a temporary *negative* id for
// adds (the server hasn't assigned one yet). When an add is finally replayed
// the real id is swapped in for any later mutation that referenced the temp id.
struct PendingMutation: Codable, Identifiable, Equatable {
    enum Kind: String, Codable {
        case add, update, move, archive, delete
    }

    let id: UUID
    var kind: Kind
    var showId: Int
    var memberSlug: String?
    let createdAt: Date

    // Payload — present depending on `kind`.
    var title: String?
    var network: String?
    var networkUrl: String?
    var list: String?
    var notes: String?
    var recommendedBy: String?
    var movie: Bool?
    var fullSeries: Bool?
    var watchingWith: String?
    var archived: Bool?
    var targetList: String?   // .move only

    init(kind: Kind, showId: Int, memberSlug: String?) {
        self.id = UUID()
        self.kind = kind
        self.showId = showId
        self.memberSlug = memberSlug
        self.createdAt = Date()
    }

    var summary: String {
        switch kind {
        case .add:     return "Add “\(title ?? "show")”"
        case .update:  return "Edit “\(title ?? "show")”"
        case .move:    return "Move show"
        case .archive: return "Archive show"
        case .delete:  return "Delete show"
        }
    }
}
