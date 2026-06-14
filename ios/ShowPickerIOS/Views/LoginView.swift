import SwiftUI
import AuthenticationServices

// Login: Sign in with Apple, OR phone (Twilio Verify) / email (Resend-delivered
// OTP). User picks whichever, gets a 6-digit code, enters it, taps Log in.
struct LoginView: View {
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
                    .frame(height: 46)
                    .listRowInsets(EdgeInsets())
                    .disabled(submitting)
                }

                Section {
                    HStack {
                        TextField("Phone", text: $phone)
                            .keyboardType(.phonePad)
                            .textContentType(.telephoneNumber)
                        sendButton(title: "Text", sent: phoneCodeSent,
                                   sending: sendingPhone, disabled: phone.isEmpty) {
                            await sendPhoneCode()
                        }
                    }
                    HStack {
                        TextField("Email", text: $email)
                            .keyboardType(.emailAddress)
                            .textContentType(.emailAddress)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        sendButton(title: "Email", sent: emailCodeSent,
                                   sending: sendingEmail, disabled: email.isEmpty) {
                            await sendEmailCode()
                        }
                    }
                    TextField("6-digit code", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.title3.monospacedDigit())
                        .multilineTextAlignment(.center)
                        .onChange(of: code) { _, newValue in
                            // Auto-submit as soon as a full 6-digit code is in.
                            if newValue.filter(\.isNumber).count == 6 && !submitting {
                                Task { await submit() }
                            }
                        }
                } header: {
                    Text("Or get a code by text or email")
                } footer: {
                    if let err = errorText {
                        Text(err).foregroundStyle(.red)
                    } else {
                        Text("The code logs you in automatically.")
                    }
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

    // Inline "send me a code" button that lives in the trailing edge of a field
    // row. .borderless keeps it a separate tap target from the text field.
    @ViewBuilder
    private func sendButton(title: String, sent: Bool, sending: Bool,
                            disabled: Bool, action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            if sending {
                ProgressView()
            } else if sent {
                Label("Sent", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            } else {
                Text(title)
            }
        }
        .buttonStyle(.borderless)
        .font(.callout)
        .disabled(disabled || sending)
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
        let trimmedCode = code.trimmingCharacters(in: .whitespaces)
        let trimmedPhone = phone.trimmingCharacters(in: .whitespaces)
        let trimmedEmail = email.trimmingCharacters(in: .whitespaces)
        guard !trimmedPhone.isEmpty || !trimmedEmail.isEmpty else {
            errorText = "Enter your phone or email above first, then the code."
            return
        }
        submitting = true
        defer { submitting = false }
        do {
            // Phone wins if both are filled — it's the more recent intent
            // (Twilio Verify holds the code; lookup happens server-side).
            if !trimmedPhone.isEmpty {
                try await auth.loginWithPhone(phone: trimmedPhone, code: trimmedCode)
            } else {
                try await auth.loginWithEmail(email: trimmedEmail, code: trimmedCode)
            }
            dismiss()
        } catch {
            errorText = "Invalid or expired code. Try again."
            code = ""
        }
    }
}
