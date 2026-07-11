import SwiftUI

// Add a brand-new show from the TV: results appear live while typing (the
// tvOS .searchable layout keeps the keyboard and grid on screen together —
// a plain TextField's full-screen keyboard would hide them). Picking a
// result pushes the list choice; the pick pins the TMDB entry so
// server-side enrichment (genres, cast, dates, network URL) can't
// mismatch. Notes / recommender stay phone-and-web edits.
struct AddShowView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var query: String
    @State private var hits: [TitleHit] = []
    @State private var picked: TitleHit?
    @State private var working = false
    @State private var errorText: String?

    init(initialQuery: String = "") {
        _query = State(initialValue: initialQuery)
    }

    private let columns = Array(repeating: GridItem(.fixed(220), spacing: 40), count: 5)

    var body: some View {
        NavigationStack {
            ScrollView {
                if hits.isEmpty {
                    Text(query.trimmingCharacters(in: .whitespaces).count >= 2
                         ? "No matches yet — keep typing."
                         : "Type a show or movie title — results appear as you type.")
                        .font(.system(size: 26))
                        .foregroundColor(Theme.muted)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 120)
                } else {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 50) {
                        ForEach(hits) { hit in
                            Button {
                                errorText = nil
                                picked = hit
                            } label: {
                                ShowCard(title: hit.title,
                                         subtitle: hit.metaText,
                                         posterUrl: hit.posterUrl)
                            }
                            .buttonStyle(PushButtonStyle())
                        }
                    }
                    .padding(.horizontal, 60)
                    .padding(.vertical, 40)
                }
            }
            .background(Theme.background.ignoresSafeArea())
            .navigationTitle("Add a show")
            .searchable(text: $query, prompt: "Show or movie title")
            .navigationDestination(item: $picked) { hit in
                confirmStep(hit)
            }
        }
        // Debounced TMDB lookup: .task(id:) cancels the in-flight search on
        // every keystroke, so only the pause-after-typing one hits the network.
        .task(id: query) { await search() }
    }

    // Which list gets the picked show. Menu pops back to the results.
    private func confirmStep(_ hit: TitleHit) -> some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 28) {
                ShowCard(title: hit.title,
                         subtitle: hit.metaText,
                         posterUrl: hit.posterUrl)
                    .frame(width: 220, height: 330)

                Text("Add “\(hit.title)” to…")
                    .font(.system(size: 28, weight: .semibold))
                    .foregroundColor(Theme.text)

                HStack(spacing: 24) {
                    ForEach(ShowList.allCases) { l in
                        Button(l.title) { Task { await add(to: l) } }
                            .disabled(working)
                    }
                }

                if let errorText {
                    Text(errorText)
                        .font(.system(size: 22))
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 900)
                }
            }
            .padding(.horizontal, 60)
        }
    }

    // MARK: Actions

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard q.count >= 2 else { hits = []; return }
        try? await Task.sleep(nanoseconds: 300_000_000)
        if Task.isCancelled { return }
        let found = (try? await API.titleSearch(q)) ?? []
        if !Task.isCancelled { hits = found }
    }

    private func add(to list: ShowList) async {
        guard let hit = picked else { return }
        working = true
        errorText = nil
        defer { working = false }
        do {
            try await API.addShow(title: hit.title, network: nil, networkUrl: nil,
                                  list: list.rawValue, movie: hit.isMovie, fullSeries: false,
                                  tmdbId: hit.tmdbId, tmdbType: hit.mediaType)
            dismiss()
        } catch API.APIError.badResponse(409) {
            errorText = "“\(hit.title)” is already on one of your lists (maybe archived)."
        } catch {
            errorText = "Couldn't add it. Please try again."
        }
    }
}
