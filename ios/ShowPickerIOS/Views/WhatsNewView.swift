import SwiftUI

// Changelog, ported from public/whats-new.html. There's no API for this, so
// the entries live here; keep roughly in sync with the web page when it
// changes. Reachable from the account menu in HomeView.
struct WhatsNewView: View {
    private struct Entry: Identifiable {
        let date: String
        let title: String
        let body: String
        var id: String { date + title }
    }

    private let entries: [Entry] = [
        .init(date: "6/29", title: "Shake to pick.", body: "Give your phone a shake to pull a random show from your Up Next list \u{2014} an instant answer to \u{201C}what should we watch?\u{201D}"),
        .init(date: "6/29", title: "Share a show.", body: "Send any show to a friend through the standard share sheet \u{2014} Messages, Mail, AirDrop, anything. Tap the share button on a show's detail screen."),
        .init(date: "6/29", title: "Seasons released.", body: "Show rows now tell you how many seasons have dropped, right next to the Next up date (e.g. \u{201C}Next up: 6/1 \u{00B7} 3 seasons\u{201D})."),
        .init(date: "6/29", title: "Straight to your shows.", body: "Open the app while you're logged in and you land right on your own list, instead of the home screen."),
        .init(date: "6/29", title: "Subscription Audit & Vibe.", body: "The subscription audit and taste-vibe pages are now in the app \u{2014} find them on your member page. This changelog moved into the account menu, too."),
        .init(date: "6/29", title: "BritBox.", body: "Added BritBox as a network option for British TV from the BBC and ITV."),
        .init(date: "5/21", title: "Calendar feed.", body: "Each member page now has a 📅 Calendar feed link at the bottom. Subscribe in Apple Calendar, Google Calendar, or Fantastical to get upcoming season premieres and finales from that member's Watching and Waiting lists, updated daily."),
        .init(date: "5/9", title: "Vibe.", body: "See a personality fingerprint based on each member's taste: cluster name, top trait signals, balance read, and shows aligned with the vibe. Open Vibe from any member's page."),
        .init(date: "5/9", title: "Picks for You.", body: "Log in and visit your Up Next list to see suggestions tailored to what your closest matches are watching. Tap + on any pick to add it straight to your Up Next."),
        .init(date: "4/28", title: "Search.", body: "Tap Search in the header to find shows by title or actor across all four lists plus archived. Each result shows the list it's on; tap a result to expand the full details."),
        .init(date: "4/28", title: "One-tap Add.", body: "The + Add button appears on your member page as soon as you're logged in. No need to enter edit mode first."),
        .init(date: "4/26", title: "Cleaner show rows.", body: "Each show is one tidy line: title, network, rating. Tap the title to expand and see genre, cast, who recommended it, next season dates, who you're watching with, and notes; only the lines with data show up."),
        .init(date: "4/21", title: "My Shows link.", body: "When logged in, a quick \u{201C}My Shows\u{201D} link appears on the home page just below the title."),
        .init(date: "4/17", title: "Quick actions.", body: "On the Watching list, \u{201C}Watched it\u{201D} moves a show to Recommending and \u{201C}Season done\u{201D} moves it to Waiting. No dropdown needed."),
        .init(date: "4/17", title: "Genre tags.", body: "Shows display genre info (Drama, Comedy, Thriller, etc.) pulled from TMDB."),
        .init(date: "4/17", title: "Share this list.", body: "Share a member's list with friends via text, email, or clipboard."),
        .init(date: "4/16", title: "What Members Are Watching.", body: "The home screen shows the most popular shows across all members. Tap a show to add it to your own list."),
        .init(date: "4/15", title: "New domain!", body: "Show Picker Club is now at showpicker.club. The old link still works too."),
        .init(date: "4/15", title: "Share shows to other members.", body: "See a show on someone else's list that you want to add to yours? Send it to another member's Up Next. It carries over the rating, network link, actors, and all the details."),
        .init(date: "4/15", title: "Sort your lists.", body: "Sort any list by Rating (default), A\u{2013}Z, Date Added, or Next up."),
        .init(date: "4/15", title: "Network links sync across members.", body: "When someone finds a good direct link for a show, it automatically copies to matching shows on other members' lists (runs once per day)."),
        .init(date: "4/15", title: "Watching With field.", body: "Track who you're watching a show with."),
        .init(date: "4/14", title: "Series Complete icon.", body: "Shows that have ended get a 🎬 badge."),
        .init(date: "4/13", title: "Suggest a Show.", body: "Logged-in members can suggest shows to any other member."),
        .init(date: "4/13", title: "Season dates.", body: "See when the next season starts (and when it ends) pulled automatically from TMDB."),
        .init(date: "4/13", title: "Multi-member support.", body: "One app, multiple members, each with their own lists and login codes."),
        .init(date: "4/13", title: "PWA support.", body: "Add Show Picker Club to your phone's home screen for an app-like experience."),
        .init(date: "4/12", title: "Initial launch.", body: "Add, edit, move, and archive shows across four lists: Watching, Waiting, Recommending, and Up Next. Auto-enriched with IMDb ratings, actors, and network links."),
    ]

    var body: some View {
        List(entries) { e in
            VStack(alignment: .leading, spacing: 4) {
                (Text(e.date).fontWeight(.semibold).foregroundColor(.primary)
                 + Text("  ")
                 + Text(e.title).fontWeight(.semibold).foregroundColor(.primary))
                    .font(.subheadline)
                Text(e.body)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)
        }
        .listStyle(.plain)
        .navigationTitle("What's New")
        .navigationBarTitleDisplayMode(.inline)
    }
}
