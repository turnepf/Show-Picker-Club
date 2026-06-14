import SwiftUI
import AuthenticationServices

// Login: Sign in with Apple, OR phone (Twilio Verify) / email (Resend-delivered
// OTP). User picks whichever, gets a 6-digit code, enters it, taps Log in.
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
                    SignInWithAppleButton(.signIn) { request in
                        request.requestedScopes = [.email, .fullName]
                    } onCompletion: { result in
                        Task { await handleApple(result) }
                    }
                    .signInWithAppleButtonStyle(.black)
                    .frame(height: 48)
                    .listRowInsets(EdgeInsets())
                    .disabled(submitting)
                } footer: {
                    Text("Use the Apple ID email the group owner has on file. Or sign in by phone or email below — we'll send you a 6-digit code.")
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
                        .onChange(of: code) { _, newValue in
                            // Auto-submit as soon as a full 6-digit code is in,
                            // so the user never has to reach for the Log in button.
                            if newValue.filter(\.isNumber).count == 6 && !submitting {
                                Task { await submit() }
                            }
                        }
                    Text("Enter the code from your text or email — it logs you in automatically.")
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

    private func handleApple(_ result: Result<ASAuthorization, Error>) async {
        errorText = nil
        switch result {
        case .success(let authorization):
            guard let cred = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = cred.identityToken,
                  let token = String(data: tokenData, encoding: .utf8) else {
                errorText = "Apple didn't return a sign-in token. Try again."
                return
            }
            submitting = true
            defer { submitting = false }
            do {
                try await auth.loginWithApple(identityToken: token)
                dismiss()
            } catch API.APIError.badResponse(401) {
                errorText = "That Apple ID isn't linked to a member yet. Pick \"Share My Email\" with the address the owner has on file, or log in by text/email."
            } catch {
                // 404/403/5xx or no network — distinct from an unrecognized member.
                errorText = "Couldn't reach sign-in. Check your connection (the Apple endpoint may not be deployed yet), or use a text/email code."
            }
        case .failure(let error):
            // Silently ignore a user-initiated cancel; surface anything else.
            if (error as? ASAuthorizationError)?.code != .canceled {
                errorText = "Apple sign-in failed. Try again."
            }
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
