import WidgetKit
import SwiftUI

// Entry point for the iPhone/iPad/Mac home-screen widgets (a WidgetKit
// extension embedded in the iOS app; SUPPORTS_MACCATALYST carries it into the
// Mac Catalyst build so the same widgets appear in the macOS widget gallery).
//
// Two widgets:
//  - Trending      — what the club is picking up right now (/api/popular, public)
//  - Upcoming      — your next premieres from Watching + Awaiting (needs the
//                    session the app parks in the shared App Group)
@main
struct ShowPickerWidgetsBundle: WidgetBundle {
    var body: some Widget {
        TrendingWidget()
        UpcomingPremieresWidget()
    }
}
