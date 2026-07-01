import WidgetKit
import SwiftUI

// Entry point for the watch complication (a WidgetKit widget extension).
// One widget for now: the next premiere from your Watching + Awaiting lists.
@main
struct ShowPickerWatchComplicationBundle: WidgetBundle {
    var body: some Widget {
        NextPremiereWidget()
    }
}
