import SwiftUI

// Paste a list of shows from somewhere else — Notes, a text file, an old
// spreadsheet — and get it sorted onto the four lists.
//
// Three steps, in one sheet:
//
//   1. paste   — a plain text box.
//   2. reading — page through /api/import/parse until the cursor comes back
//                nil, accumulating rows. A short list finishes on the first
//                call and this step flashes past; a very long one shows real
//                progress instead of an indefinite spinner.
//   3. review  — every row, with the list it was put on, editable. Nothing is
//                written until "Add" is tapped.
//
// The review step is not politeness: /api/import/parse deliberately resolves
// titles without enriching them, so this is the only place a wrong list or a
// mis-matched title gets caught before it's in the member's library.
struct ImportListView: View {
    // No member slug: /api/import/commit always writes to the caller's own
    // lists, resolved from the session, exactly like /api/export reads them.
    //
    // `defaultList` is where an unplaced title lands, and it is the list the
    // member was looking at when they opened this — the same context rule
    // Add Show follows (AddEditShowView's initialList). A bare list of titles
    // means something different from Next Up than it does from Watching, and
    // the server has no way to know which door was used. Callers with no list
    // in view (Home) leave it at Watching.
    var defaultList: ShowList = .watching
    let onFinished: () async -> Void

    @Environment(\.dismiss) private var dismiss

    private enum Step { case paste, reading, review }
    @State private var step: Step = .paste
    @State private var text = ""
    @State private var items: [ImportItem] = []
    // Rows the member unchecked, plus the duplicates that start unchecked.
    @State private var excluded: Set<UUID> = []
    @State private var progress: Double = 0
    @State private var committing = false
    @State private var errorText: String?

    private var included: [ImportItem] { items.filter { !excluded.contains($0.id) } }

    var body: some View {
        NavigationStack {
            Group {
                switch step {
                case .paste:   pasteStep
                case .reading: readingStep
                case .review:  reviewStep
                }
            }
            .navigationTitle(step == .review ? "Review \(items.count) title\(items.count == 1 ? "" : "s")" : "Import a list")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(committing)
                }
                ToolbarItem(placement: .confirmationAction) {
                    switch step {
                    case .paste:
                        Button("Read list") { Task { await read() } }
                            .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    case .reading:
                        EmptyView()
                    case .review:
                        // Nothing matched? "Finish" still lists (and emails)
                        // the titles to add by hand.
                        Button(committing ? "Adding…" : (included.isEmpty ? "Finish" : "Add \(included.count)")) { Task { await commit() } }
                            .disabled(committing || (included.isEmpty && !items.contains { $0.matched == false }))
                    }
                }
            }
        }
    }

    // MARK: Step 1 — paste

    private var pasteStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Paste your list below. Headings like \"Currently watching\" or \"Favourites\" are used to sort titles onto the right list, and any notes you wrote come along with them.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
                .padding(.top, 12)

            // The example sits outside the editor, not inside it as placeholder
            // text: as ghost text it vanished the moment anything was pasted,
            // which is exactly when someone wants to compare their list against
            // it. Here it stays put while they paste, edit and re-read.
            exampleCard
                .padding(.horizontal)

            // The list is nearly always already on the clipboard when someone
            // opens this sheet — they copied it in Notes or Messages to get
            // here. PasteButton rather than a plain button reading
            // UIPasteboard: an explicit tap on the system control is its own
            // consent, so it doesn't raise the "allow paste?" alert.
            HStack {
                Spacer()
                PasteButton(payloadType: String.self) { strings in
                    guard let pasted = strings.first,
                          !pasted.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    else { return }
                    Task { @MainActor in
                        // Append rather than replace: someone who has already
                        // typed or pasted a first batch shouldn't lose it to a
                        // second tap.
                        text = text.isEmpty ? pasted : text + "\n" + pasted
                    }
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)
            }
            .padding(.horizontal)

            TextEditor(text: $text)
                .font(.body)
                .scrollContentBackground(.hidden)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(.horizontal)
                .accessibilityLabel("Your list")

            if let errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
            }

            Text("Nothing is added until you've looked it over.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
                .padding(.bottom, 12)
        }
    }

    // A worked example of a paste. Deliberately uses two of the app's own list
    // names as headings and the "on <service>" form, since those are the two
    // things the parser reads structure from — a heading is what puts a title
    // somewhere other than the default list, and "on <service>" is what fills
    // the network field. Neither is required, so the last line names where an
    // unheaded list actually lands rather than letting the example read as a
    // format the paste has to match. That line has to track `defaultList`: it
    // is the only place the member is told where a bare list goes, so hard-
    // coding "Watching" here would be a lie from the Next Up door.
    private var exampleCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("For example")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text("Watching").fontWeight(.semibold)
                Text("Severance on Apple TV+")
                Text("The Bear on Hulu")
                Text("")
                Text("Next Up").fontWeight(.semibold)
                Text("The Diplomat on Netflix")
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
            Text("Headings are optional — a plain list of titles lands on \(defaultList.title).")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Color(.secondarySystemBackground),
                    in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    // MARK: Step 2 — reading

    private var readingStep: some View {
        VStack(spacing: 14) {
            ProgressView(value: progress)
                .progressViewStyle(.linear)
                .padding(.horizontal, 40)
            Text(items.isEmpty ? "Reading your list…" : "Reading your list… \(items.count) so far")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Step 3 — review

    private var reviewStep: some View {
        List {
            if items.isEmpty {
                Section {
                    Text("Couldn't find any show or film titles in that. Go back and check it's a list of titles.")
                        .foregroundStyle(.secondary)
                }
            }
            ForEach($items) { $item in
                reviewRow($item)
            }
            if !items.isEmpty {
                Section {
                    Text("Tap the circle to leave a title out, or change the list it lands on. Titles you already have are greyed out and won't be added again. Posters, cast and watch links fill in shortly after.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let errorText {
                Section { Text(errorText).font(.caption).foregroundStyle(.red) }
            }
        }
        .listStyle(.insetGrouped)
    }

    @ViewBuilder private func reviewRow(_ item: Binding<ImportItem>) -> some View {
        let dupe = item.wrappedValue.isDuplicate
        let isOut = excluded.contains(item.wrappedValue.id)
        HStack(alignment: .top, spacing: 10) {
            // An explicit toggle button rather than a tap on the whole row:
            // the row also holds a Picker, and a row-wide tap gesture with a
            // contentShape swallows its taps.
            Button {
                toggle(item.wrappedValue)
            } label: {
                Image(systemName: dupe ? "minus.circle" : (isOut ? "circle" : "checkmark.circle.fill"))
                    .foregroundStyle(isOut || dupe ? Color.secondary : Color.accentColor)
                    .padding(.top, 22)
            }
            .buttonStyle(.plain)
            .disabled(dupe)
            .accessibilityLabel(dupe
                                ? "\(item.wrappedValue.title), already on your lists"
                                : "\(isOut ? "Include" : "Leave out") \(item.wrappedValue.title)")

            PosterThumb(url: item.wrappedValue.posterUrl)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.wrappedValue.title)
                    .fontWeight(.medium)
                if let year = item.wrappedValue.year {
                    Text(String(year))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                // Only shown when TMDB changed what the member typed, so a
                // wrong match is visible rather than a silent correction.
                if let raw = item.wrappedValue.rawTitle, raw.caseInsensitiveCompare(item.wrappedValue.title) != .orderedSame {
                    Label("You wrote \"\(raw)\"", systemImage: "pencil")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if item.wrappedValue.matched == false {
                    Label("No match found — can't be added. Add it by hand from search.", systemImage: "questionmark.circle")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                if let existing = item.wrappedValue.existingList,
                   let list = ShowList(rawValue: existing) {
                    Label("Already on \(list.title)", systemImage: "checkmark.seal")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                } else if item.wrappedValue.existingArchived == true {
                    Label("You archived this before", systemImage: "archivebox")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let notes = item.wrappedValue.notes {
                    Text(notes)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Picker("List", selection: item.list) {
                    ForEach(ShowList.allCases) { list in
                        Text(list.title).tag(list.rawValue)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .disabled(isOut)
            }
            Spacer(minLength: 0)
        }
        .opacity(isOut ? 0.5 : 1)
    }

    // Duplicates are locked out rather than merely unchecked: /api/import/commit
    // skips a title the member already has, archived ones included, so letting
    // them tick it back on would promise an add that silently never happens.
    private func toggle(_ item: ImportItem) {
        // A title TMDB couldn't match can't be added (every show is a TMDB
        // entry), so it stays out like a duplicate does.
        guard !item.isDuplicate, item.matched != false else { return }
        if excluded.contains(item.id) { excluded.remove(item.id) } else { excluded.insert(item.id) }
    }

    // MARK: Work

    // Page through the parser until the cursor comes back nil. A paste under
    // ~12k characters is a single call; anything longer keeps going, so a very
    // long list is slow rather than capped.
    private func read() async {
        errorText = nil
        items = []
        excluded = []
        progress = 0
        step = .reading

        var cursor = 0
        var section = ""
        let total = max(text.count, 1)
        // Belt and braces: the server always advances the cursor, but a bug
        // that didn't would otherwise spin here forever.
        var slices = 0

        while slices < 200 {
            do {
                let page = try await API.importParse(text: text, cursor: cursor, section: section,
                                                     defaultList: defaultList)
                items.append(contentsOf: page.items)
                section = page.section ?? ""
                guard let next = page.nextCursor else {
                    progress = 1
                    break
                }
                guard next > cursor else { break }
                cursor = next
                progress = min(Double(cursor) / Double(total), 0.99)
                slices += 1
            } catch {
                errorText = importFailure(error)
                step = .paste
                return
            }
        }

        // Anything already on one of their lists starts — and stays — out.
        // See toggle(): commit skips these, so offering to include them would
        // promise an add that never happens.
        excluded = Set(items.filter { $0.isDuplicate || $0.matched == false }.map { $0.id })
        step = .review
    }

    private func commit() async {
        errorText = nil
        committing = true
        defer { committing = false }

        var added = 0
        // Titles TMDB couldn't match: the ones left out at review plus any the
        // server set aside. Listed at the end, to add by hand from search.
        var unmatched = items.filter { $0.matched == false }.map { $0.title }
        // Snapshot once: `included` recomputes off two @State properties, and
        // the batch maths needs a stable count.
        let rows = included
        // The server caps one call at 200 rows; send in batches so a big
        // import is a few requests rather than a rejection. The last call
        // (made even when there's nothing to add) carries the titles left out
        // at review, so the member gets one email listing what to add by hand.
        var emailed = false
        let starts = rows.isEmpty ? [0] : Array(stride(from: 0, to: rows.count, by: 100))
        for start in starts {
            let batch = rows.isEmpty ? [] : Array(rows[start..<min(start + 100, rows.count)])
            let isFinal = start == starts.last
            do {
                let result = try await API.importCommit(items: batch, final: isFinal,
                                                        unmatchedTitles: unmatched, addedBefore: added)
                added += result.added
                for t in result.unmatchedTitles ?? [] where !unmatched.contains(t) { unmatched.append(t) }
                if isFinal { emailed = result.emailed ?? false }
            } catch {
                // Report what did land before the failure — silently losing a
                // partial import is worse than an awkward message.
                errorText = added > 0
                    ? "Added \(added) before this failed: \(API.failureLine(error, action: "finish the import"))"
                    : API.failureLine(error, action: "add these shows")
                return
            }
        }

        // Imported rows go in with a poster and a TMDB id but no cast,
        // overview or real watch link. Nudge the background pass so they fill
        // in now rather than on the next scheduled rotation.
        Task { try? await API.enrich() }
        await onFinished()
        if unmatched.isEmpty {
            dismiss()
        } else {
            // Stay open so the list doesn't vanish: nothing left to add, and a
            // note naming what wasn't found.
            items = []
            excluded = []
            let n = unmatched.count
            errorText = "Added \(added) show\(added == 1 ? "" : "s"). No match was found for \(n), so \(n == 1 ? "it wasn't" : "they weren't") added. Add \(n == 1 ? "it" : "them") by hand from search: "
                + unmatched.joined(separator: ", ") + (emailed ? ". We've emailed you this list too." : "")
        }
    }

    private func importFailure(_ error: Error) -> String {
        if let e = error as? API.APIError, case .rejected(let r) = e {
            switch r.code {
            case "import_unavailable": return "List import isn't switched on for this server yet."
            case "text_too_long":      return "That's a lot of text — split it into a couple of pastes."
            case "rate_limited":       return "You've added a lot today. Try the rest tomorrow."
            case "parse_failed":       return "Couldn't read that list. Try again in a moment."
            default: break
            }
        }
        return API.failureLine(error, action: "read your list")
    }
}
