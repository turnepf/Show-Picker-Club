import SwiftUI

// 4-digit code login. Plumbed for the current backend; once SMS lands the
// flow swaps to phone-entry → texted code, but the AuthStore stays the same.
struct LoginView: View {
    let memberSlug: String

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthStore
    @State private var code = ""
    @State private var submitting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Enter your 4-digit code to edit this list.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section {
                    TextField("Code", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.title2.monospacedDigit())
                        .multilineTextAlignment(.center)
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Log in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Log in") { Task { await submit() } }
                        .disabled(code.count != 4 || submitting)
                }
            }
            .overlay { if submitting { ProgressView().controlSize(.large) } }
        }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        do {
            try await auth.login(member: memberSlug, code: code)
            dismiss()
        } catch {
            errorText = "Invalid code. Try again."
            code = ""
        }
    }
}
