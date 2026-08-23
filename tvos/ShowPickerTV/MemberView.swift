import SwiftUI

struct MemberView: View {
    let member: Member
    // True on the signed-in member's own view (My Shows): shows the
    // "Add a show" entry point.
    var canAdd: Bool = false
    @State private var shows: [Show] = []
    @State private var loading = true
    @State private var didInitialLoad = false
    @State private var errorText: String?
    @State private var showingAdd = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 50) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(member.label)'s Shows")
                        .font(.system(size: 48, weight: .bold))
                        .foregroundColor(Theme.text)
                    if canAdd {
                        Spacer()
                        Button { showingAdd = true } label: {
                            Label("Add a Show", systemImage: "plus")
                                .font(.system(size: 24, weight: .semibold))
                        }
                        .buttonStyle(ActionButtonStyle())
                    }
                }
                .padding(.top, 20)

                if loading {
                    ProgressView().padding(.top, 80)
                } else if let errorText {
                    Text(errorText).foregroundColor(Theme.muted)
                } else {
                    let hasLists = !shows.allSatisfy { ShowList(rawValue: $0.list) == nil }
                    if hasLists {
                        ForEach(ShowList.allCases) { list in
                            let items = shows.filter { $0.list == list.rawValue }
                            if !items.isEmpty {
                                shelf(list: list, items: items)
                            }
                        }
                    } else {
                        // Defensive empty-state: the tvOS focus engine needs some
                        // visible content to land on, otherwise the screen looks
                        // hung when every list is empty.
                        VStack(spacing: 24) {
                            Text(canAdd ? "You haven't added any shows yet."
                                        : "\(member.label) \(member.labelIsPlural ? "haven't" : "hasn't") added any shows yet.")
                                .font(.system(size: 32))
                                .foregroundColor(Theme.muted)
                                .multilineTextAlignment(.center)
                            Text(canAdd ? "Use “Add a show” above to start your first list."
                                        : "Check back later, or pick another member from the home page.")
                                .font(.system(size: 24))
                                .foregroundColor(Theme.muted)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 80)
                    }
                }
            }
            .padding(.horizontal, 60)
            .padding(.bottom, 60)
        }
        .background(Theme.background.ignoresSafeArea())
        // First appearance: full load (with the spinner).
        .task { if !didInitialLoad { await load(); didInitialLoad = true } }
        // Returning here (e.g. after archiving / moving a show from its detail):
        // refresh quietly — no `loading` toggle, so the scroll position holds
        // and the lists reflect the change instead of showing stale data.
        .onAppear {
            guard didInitialLoad else { return }
            Task {
                if let s = try? await API.shows(member: member.slug) { shows = s }
            }
        }
        // Quiet refresh after adding, same as returning from a detail screen.
        .fullScreenCover(isPresented: $showingAdd, onDismiss: {
            Task {
                if let s = try? await API.shows(member: member.slug) { shows = s }
            }
        }) {
            AddShowView()
        }
    }

    private func shelf(list: ShowList, items: [Show]) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Circle().fill(Theme.listColor(list.rawValue)).frame(width: 18, height: 18)
                Text(list.title)
                    .font(.system(size: 32, weight: .semibold))
                    .foregroundColor(Theme.text)
                // Per-network counts, mirroring the web list footer. Lives in
                // the shelf header because the shelves scroll horizontally —
                // there is no per-list bottom edge to hang a footer on.
                if let counts = NetworkTally.line(for: items) {
                    Text(counts)
                        .font(.system(size: 20))
                        .foregroundColor(Theme.muted)
                        .padding(.leading, 8)
                }
            }
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(alignment: .top, spacing: 40) {
                    // Canonical ordering from ShowPickerCore: a member's own
                    // "My Order" if they arranged one (TV has no sort UI of
                    // its own), otherwise the list default.
                    ForEach(items.orderedForList(list)) { show in
                        NavigationLink(value: Route.detail(id: show.id, title: show.title, network: show.network, rating: show.rating)) {
                            // Premiere badge on every shelf — a Loved show
                            // that drops a new season deserves the flag.
                            ShowCard(title: show.title,
                                     nextUp: show.nextUpRange,
                                     networkLogoUrl: show.networkLogoUrl,
                                     posterUrl: show.posterUrl)
                        }
                        .buttonStyle(PushButtonStyle())
                    }
                }
                // Room so a focused card can grow without the ScrollView
                // clipping it ("growing behind a wall").
                .padding(.horizontal, 14)
                .padding(.vertical, 30)
            }
        }
        // Let the tvOS focus engine move up/down between shelves. Without this,
        // focus can drop into a lower row but won't climb back out of it.
        .focusSection()
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            shows = try await API.shows(member: member.slug)
        } catch API.APIError.badResponse(401) {
            errorText = "You're logged out — sign in again from the Account tab."
        } catch {
            errorText = "Couldn't load \(member.label)'s shows."
        }
    }
}
