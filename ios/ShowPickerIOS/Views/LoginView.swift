import SwiftUI

// Login: phone (Twilio Verify) OR email (Resend-delivered OTP). User
// picks whichever, gets a 6-digit code, enters it, taps Log in.
struct LoginView: View {
    let memberSlug: String

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthStore
    @State private var phone = ""
    @State private var email = ""
    @State private var code = ""
    @State private var submitting = false
    @State private var sendingPhone = false
    @State private var sendingEmail = false
    @State private var phoneCodeSent = false
    @State private var emailCodeSent = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Log in by phone or email — we'll send you a 6-digit code.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Phone") {
                    TextField("(336) 555-1234", text: $phone)
                        .keyboardType(.phonePad)
                        .textContentType(.telephoneNumber)
                    Button {
                        Task { await sendPhoneCode() }
                    } label: {
                        if sendingPhone {
                            ProgressView()
                        } else if phoneCodeSent {
                            Label("Code sent — check your texts", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Text("Text me a code")
                        }
                    }
                    .disabled(phone.isEmpty || sendingPhone)
                }

                Section("Email") {
                    TextField("you@example.com", text: $email)
                        .keyboardType(.emailAddress)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button {
                        Task { await sendEmailCode() }
                    } label: {
                        if sendingEmail {
                            ProgressView()
                        } else if emailCodeSent {
                            Label("Code sent — check your email", systemImage: "checkmark.circle.fill")
                                .foregroundStyle(.green)
                        } else {
                            Text("Email me a code")
                        }
                    }
                    .disabled(email.isEmpty || sendingEmail)
                }

                Section("Code") {
                    TextField("••••••", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.title2.monospacedDigit())
                        .multilineTextAlignment(.center)
                    Text("Enter the code from your text or email.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red) }
                }

                Section {
                    Text("If you don't receive a text or email, reach out to the group owner with the phone or email you'd like to use.")
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

    private func sendPhoneCode() async {
        sendingPhone = true
        errorText = nil
        defer { sendingPhone = false }
        do {
            _ = try await API.requestSmsCode(phone: phone.trimmingCharacters(in: .whitespaces))
            phoneCodeSent = true
        } catch {
            errorText = "Couldn't send. Check the number and try again."
        }
    }

    private func sendEmailCode() async {
        sendingEmail = true
        errorText = nil
        defer { sendingEmail = false }
        do {
            _ = try await API.requestEmailCode(email: email.trimmingCharacters(in: .whitespaces))
            emailCodeSent = true
        } catch {
            errorText = "Couldn't send. Check the address and try again."
        }
    }

    private func submit() async {
        submitting = true
        defer { submitting = false }
        let trimmedCode = code.trimmingCharacters(in: .whitespaces)
        let trimmedPhone = phone.trimmingCharacters(in: .whitespaces)
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
        do {
            // Phone wins if both are filled — it's the more recent intent
            // (Twilio Verify holds the code; lookup happens server-side).
            if !trimmedPhone.isEmpty {
                try await auth.loginWithPhone(phone: trimmedPhone, code: trimmedCode)
            } else if !trimmedEmail.isEmpty {
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
