import SwiftUI

// Add a brand-new show from the TV: type a few characters, pick the exact
// title from TMDB type-ahead results (poster tiles), then choose a list.
// The pick pins the TMDB entry so server-side enrichment (genres, cast,
// dates, network URL) can't mismatch — which is what makes remote-keyboard
// entry workable: 3-4 characters and a click, not a full typed title.
// Notes / recommender stay phone-and-web things; they can be edited later.
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
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 36) {
                Text("Add a show")
                    .font(.system(size: 48, weight: .bold))
                    .foregroundColor(Theme.text)
                    .padding(.top, 40)

                if let picked {
                    pickedStep(picked)
                } else {
                    searchStep
                }

                if let errorText {
                    Text(errorText)
                        .font(.system(size: 22))
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                }

                Button("Cancel") { dismiss() }
                    .font(.system(size: 24))
                    .disabled(working)
                    .padding(.bottom, 40)
            }
            .padding(.horizontal, 60)
        }
        // Debounced TMDB lookup: .task(id:) cancels the in-flight search on
        // every keystroke, so only the pause-after-typing one hits the network.
        .task(id: query) { await search() }
    }

    // MARK: Steps

    private var searchStep: some View {
        VStack(spacing: 28) {
            TextField("Start typing a title…", text: $query)
                .font(.system(size: 30))
                .frame(maxWidth: 900)

            if hits.isEmpty {
                Text(query.trimmingCharacters(in: .whitespaces).count >= 2
                     ? "No matches yet — keep typing."
                     : "Type a couple of characters and pick the show from the results.")
                    .font(.system(size: 24))
                    .foregroundColor(Theme.muted)
            } else {
                ScrollView {
                    LazyVGrid(columns: columns, alignment: .leading, spacing: 50) {
                        ForEach(hits) { hit in
                            Button { picked = hit } label: {
                                ShowCard(title: hit.title,
                                         subtitle: hit.metaText,
                                         posterUrl: hit.posterUrl)
                            }
                            .buttonStyle(PushButtonStyle())
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 30)
                }
                .focusSection()
            }
        }
    }

    private func pickedStep(_ hit: TitleHit) -> some View {
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

            Button("Not this one — back to results") { picked = nil; errorText = nil }
                .font(.system(size: 22))
                .disabled(working)
        }
    }

    // MARK: Actions

    private func search() async {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard picked == nil else { return }
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
