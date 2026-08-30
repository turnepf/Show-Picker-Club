import SwiftUI
import ShowPickerCore

// Group icons (migration 066): the badge every surface renders and the picker
// the creator sets it with. The choices live in ShowPickerCore.GroupIcon and
// mirror the server's curated sets — the server rejects anything else, so
// nothing here needs to re-validate what comes back.

// A named accent color from the curated palette. The names are system color
// names on purpose: they track light/dark appearance for free, and a token
// survives a design-system reshuffle where a stored hex wouldn't.
func groupTint(_ name: String?) -> Color {
    switch name {
    case "red": return .red
    case "orange": return .orange
    case "yellow": return .yellow
    case "green": return .green
    case "teal": return .teal
    case "blue": return .blue
    case "indigo": return .indigo
    case "purple": return .purple
    case "pink": return .pink
    case "brown": return .brown
    default: return .gray
    }
}

// The one way a group's icon draws, so the list rows, the detail header and
// the picker preview can't drift. A group that never picked anything gets the
// neutral default rather than a hole — the row layout stays uniform.
struct GroupIconBadge: View {
    let icon: String?
    let color: String?
    var size: CGFloat = 36

    var body: some View {
        Image(systemName: icon ?? "person.2.fill")
            .font(.system(size: size * 0.45, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(groupTint(color).gradient, in: Circle())
    }
}

// Symbol grid plus color row, shared by the create sheet and the detail
// screen's "Change icon". Selection is optional both ways: tapping the chosen
// symbol again clears it (back to the neutral badge), and the color row
// leads with an explicit None.
struct GroupIconPicker: View {
    @Binding var icon: String?
    @Binding var color: String?

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 10), count: 6)

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(GroupIcon.symbols, id: \.self) { symbol in
                    let selected = icon == symbol
                    Button {
                        icon = selected ? nil : symbol
                    } label: {
                        Image(systemName: symbol)
                            .font(.system(size: 18, weight: .semibold))
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .foregroundStyle(selected ? Color.white : groupTint(color))
                            .background(selected ? groupTint(color) : Color(.secondarySystemBackground),
                                        in: RoundedRectangle(cornerRadius: 10))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(symbol.replacingOccurrences(of: ".", with: " "))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    noneSwatch
                    ForEach(GroupIcon.colors, id: \.self) { name in
                        colorSwatch(name)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var noneSwatch: some View {
        Button {
            color = nil
        } label: {
            Circle()
                .strokeBorder(Color.secondary, lineWidth: 2)
                .frame(width: 30, height: 30)
                .overlay(Image(systemName: "slash.circle").font(.caption).foregroundStyle(.secondary))
                .overlay(selectionRing(active: color == nil))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("No color")
    }

    private func colorSwatch(_ name: String) -> some View {
        Button {
            color = name
        } label: {
            Circle()
                .fill(groupTint(name).gradient)
                .frame(width: 30, height: 30)
                .overlay(selectionRing(active: color == name))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(name)
        .accessibilityAddTraits(color == name ? .isSelected : [])
    }

    private func selectionRing(active: Bool) -> some View {
        Circle()
            .strokeBorder(Color.primary.opacity(active ? 0.8 : 0), lineWidth: 2)
            .padding(-4)
    }
}

#Preview {
    struct Host: View {
        @State var icon: String? = "flame.fill"
        @State var color: String? = "orange"
        var body: some View {
            VStack(spacing: 20) {
                GroupIconBadge(icon: icon, color: color, size: 44)
                GroupIconPicker(icon: $icon, color: $color)
            }
            .padding()
        }
    }
    return Host()
}
