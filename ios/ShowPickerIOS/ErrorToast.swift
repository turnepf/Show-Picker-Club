import SwiftUI

// App-wide surface for failures the user should know about. Reads fall back
// to the offline cache and offline writes queue for replay, so anything
// reported here is a real rejection (server said no, or an unexpected error)
// that would otherwise silently do nothing.
@MainActor
final class ErrorCenter: ObservableObject {
    static let shared = ErrorCenter()

    @Published var message: String?
    private var dismissTask: Task<Void, Never>?

    // Show a transient toast. `what` is the action that failed, phrased for
    // "Couldn't {what}." — e.g. report("archive the show").
    func report(_ what: String) {
        message = "Couldn't \(what). Please try again."
        dismissTask?.cancel()
        dismissTask = Task {
            try? await Task.sleep(for: .seconds(4))
            if !Task.isCancelled { message = nil }
        }
    }

    // Run a user-initiated mutation, surfacing any thrown error as a toast.
    // Returns true on success so callers can skip follow-up work on failure.
    @discardableResult
    static func run(_ what: String, _ op: () async throws -> Void) async -> Bool {
        do {
            try await op()
            return true
        } catch {
            shared.report(what)
            return false
        }
    }
}

// Bottom-anchored toast, styled like the offline banner. Attach once at the
// root; every ErrorCenter.report anywhere in the app lands here.
struct ErrorToastModifier: ViewModifier {
    @ObservedObject private var center = ErrorCenter.shared

    func body(content: Content) -> some View {
        content.overlay(alignment: .bottom) {
            if let message = center.message {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(message).font(.caption.weight(.medium))
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.red.opacity(0.15), in: Capsule())
                .foregroundStyle(.red)
                .padding(.bottom, 12)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .accessibilityAddTraits(.updatesFrequently)
                .onTapGesture { center.message = nil }
            }
        }
        .animation(.snappy, value: center.message)
    }
}

extension View {
    func errorToasts() -> some View { modifier(ErrorToastModifier()) }
}
