import SwiftUI

// Email-only login: enter address, get a 6-digit OTP, paste it in.
// /auth/login no longer accepts the legacy static code.
struct LoginView: View {
    let memberSlug: String

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthStore
    @State private var email = ""
    @State private var code = ""
    @State private var submitting = false
    @State private var sendingCode = false
    @State private var codeSent = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Log in with your email — we'll send you a 6-digit code.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Email") {
                    TextField("you@example.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { await sendCode() }
                    } label: {
                        if sendingCode {
                            ProgressView()
                        } else if codeSent {
                            Label("Code sent — check your email", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Text("Email me a code")
                        }
                    }
                    .disabled(email.isEmpty || sendingCode)
                }

                Section("Code") {
                    TextField("••••••", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.title2.monospacedDigit())
                        .multilineTextAlignment(.center)
                    Text("Enter the code from your email.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }

                Section {
                    Text("If your email isn't on file, reach out to the group owner to get it added.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Log in")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Log in") { Task { await submit() } }
                        .disabled(code.count < 4 || submitting)
                }
            }
            .overlay { if submitting { ProgressView().controlSize(.large) } }
        }
    }

    private func sendCode() async {
        sendingCode = true
        errorText = nil
        defer { sendingCode = false }
        do {
            _ = try await API.requestEmailCode(email: email.trimmingCharacters(in: .whitespaces))
            codeSent = true
        } catch {
            errorText = "Couldn't send. Check the address and try again."
        }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        let trimmedCode = code.trimmingCharacters(in: .whitespaces)
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
        do {
            if !trimmedEmail.isEmpty {
                try await auth.loginWithEmail(email: trimmedEmail, code: trimmedCode)
            } else {
                try await auth.login(member: memberSlug, code: trimmedCode)
            }
            dismiss()
        } catch {
            errorText = "Invalid or expired code. Try again."
            code = ""
        }
    }
}
