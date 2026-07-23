import SwiftUI

// 10-segment tap row for entering a 1-10 rating — deliberately not a
// slider or stepper: tap a position and onRate fires immediately, the
// caller persists it (no separate Save step). Mirrors the web's
// ratingTapRow (public/index.html).
struct RatingTapRow: View {
    let value: Int?
    let onRate: (Int) -> Void

    var body: some View {
        HStack(spacing: 3) {
            ForEach(1...10, id: \.self) { i in
                RoundedRectangle(cornerRadius: 3)
                    .fill(filled(i) ? Color.orange : Color(.systemGray5))
                    .frame(height: 20)
                    .contentShape(Rectangle())
                    .onTapGesture { onRate(i) }
            }
        }
    }

    private func filled(_ i: Int) -> Bool {
        guard let value else { return false }
        return i <= value
    }
}

// A label above a tap row — one "rate this" entry (the overall rating, or
// one season). Matches the web's .rating-entry block.
struct RatingEntryRow: View {
    let label: String
    let value: Int?
    let onRate: (Int) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            RatingTapRow(value: value, onRate: onRate)
        }
        .padding(.vertical, 4)
    }
}
