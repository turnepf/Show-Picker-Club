import SwiftUI

// Login flow: email-first (the new path) with the legacy 4-digit code
// path still present until end-of-day June 7 ET. After that, /auth/login
// stops accepting static codes server-side, so the UI keeps the same
// shape and the 4-digit attempt just fails.
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

    private static let legacyCutoff = Date(timeIntervalSince1970: 1749355200)  // 00:00 ET 2026-06-08

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
                    if Date() < Self.legacyCutoff {
                        Text("Enter the code from your email — or your original 4-digit code (works through June 7th).")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("Enter the code from your email.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }

                Section {
                    Text("If your email isn't on file, text Patrick to add it.")
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
