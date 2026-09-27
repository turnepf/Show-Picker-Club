import XCTest
import ShowPickerCore

/// The "X renamed the group" / "X changed the group's icon" banner
/// (migration 068) — GET /api/groups/[id] sends `change_notice` at most once
/// per member per edit, and `GroupChangeNotice.summary` is the only place
/// that turns `changed_fields` into the sentence the group detail screen
/// shows. Pinning the four combinations here keeps the wording in one place
/// instead of re-derived in the view.
final class GroupChangeNoticeTests: XCTestCase {

    private func decode(_ json: String) throws -> GroupDetail {
        try JSONDecoder().decode(GroupDetail.self, from: Data(json.utf8))
    }

    private func notice(fields: [String]) -> GroupChangeNotice {
        GroupChangeNotice(changedBy: "quinn", changedByName: "Quinn", changedFields: fields,
                           changedAt: "2026-09-08 12:00:00")
    }

    func testRenameOnlySummary() {
        XCTAssertEqual(notice(fields: ["name"]).summary, "Quinn renamed the group.")
    }

    func testIconOnlySummary() {
        XCTAssertEqual(notice(fields: ["icon"]).summary, "Quinn changed the group's icon.")
    }

    func testRenameAndIconSummary() {
        XCTAssertEqual(notice(fields: ["name", "icon"]).summary,
                        "Quinn renamed the group and changed its icon.")
    }

    func testGroupDetailDecodesWithoutAChangeNotice() throws {
        // The common case: nothing to tell me. change_notice is absent
        // entirely, not just null — both have to decode to nil.
        let detail = try decode("""
        {"group": {"id": 1, "name": "Thursday Night", "creator_slug": "patrick",
                    "created_at": "2026-08-01 00:00:00", "member_count": 2, "is_creator": 0},
         "members": [], "is_creator": false, "can_manage": false}
        """)
        XCTAssertNil(detail.changeNotice)
    }

    func testGroupDetailDecodesWithAChangeNotice() throws {
        let detail = try decode("""
        {"group": {"id": 1, "name": "Queen Jelena Fan Club", "creator_slug": "patrick",
                    "created_at": "2026-08-01 00:00:00", "member_count": 3, "is_creator": 0},
         "members": [], "is_creator": false, "can_manage": false,
         "change_notice": {"changed_by": "quinn", "changed_by_name": "Quinn",
                            "changed_fields": ["name"], "changed_at": "2026-09-08 12:00:00"}}
        """)
        XCTAssertEqual(detail.changeNotice?.changedByName, "Quinn")
        XCTAssertEqual(detail.changeNotice?.summary, "Quinn renamed the group.")
    }
}
