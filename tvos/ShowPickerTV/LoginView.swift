import SwiftUI

// tvOS sign-in: enter a phone or email, get a 6-digit code by text/email, type
// it in, log in. Mirrors the iOS phone/email OTP flow (Sign in with Apple is
// iPhone-only). Presented over the open home screen; on success the session
// cookie is set, this screen dismisses, and Home jumps to the member's list.
struct LoginView: View {
    @EnvironmentObject private var auth: AuthStore
    @Environment(\.dismiss) private var dismiss

    @State private var phone = ""
    @State private var email = ""
    @State private var code = ""
    @State private var sendingPhone = false
    @State private var sendingEmail = false
    @State private var phoneCodeSent = false
    @State private var emailCodeSent = false
    @State private var submitting = false
    @State private var errorText: String?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 36) {
                Text("Show Picker Club")
                    .font(.system(size: 56, weight: .bold))
                    .foregroundColor(Theme.text)

                Text("Sign in to see the club's lists")
                    .font(.system(size: 26))
                    .foregroundColor(Theme.muted)

                VStack(spacing: 24) {
                    HStack(spacing: 20) {
                        TextField("Phone", text: $phone)
                            .textContentType(.telephoneNumber)
                            .keyboardType(.phonePad)
                        sendButton(title: "Text me a code", sent: phoneCodeSent,
                                   sending: sendingPhone, disabled: phone.isEmpty) {
                            await sendPhoneCode()
                        }
                    }

                    HStack(spacing: 20) {
                        TextField("Email", text: $email)
                            .textContentType(.emailAddress)
                            .keyboardType(.emailAddress)
                        sendButton(title: "Email me a code", sent: emailCodeSent,
                                   sending: sendingEmail, disabled: email.isEmpty) {
                            await sendEmailCode()
                        }
                    }

                    TextField("6-digit code", text: $code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .font(.system(size: 30, weight: .semibold).monospacedDigit())
                        .multilineTextAlignment(.center)
                        .onChange(of: code) { _, newValue in
                            // Auto-submit once a full 6-digit code is entered.
                            if newValue.filter(\.isNumber).count == 6 && !submitting {
                                Task { await submit() }
                            }
                        }
                }
                .frame(maxWidth: 760)

                HStack(spacing: 24) {
                    Button("Not now") { dismiss() }
                        .font(.system(size: 24))

                    Button(action: { Task { await submit() } }) {
                        Text(submitting ? "Logging in…" : "Log in")
                            .font(.system(size: 26, weight: .semibold))
                            .frame(maxWidth: 360)
                    }
                    .disabled(code.filter(\.isNumber).count < 4 || submitting)
                }

                if let errorText {
                    Text(errorText)
                        .font(.system(size: 22))
                        .foregroundColor(.red)
                } else {
                    Text("The code logs you in automatically.")
                        .font(.system(size: 20))
                        .foregroundColor(Theme.muted)
                }
            }
            .padding(.horizontal, 120)
        }
    }

    @ViewBuilder
    private func sendButton(title: String, sent: Bool, sending: Bool,
                            disabled: Bool, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            if sending {
                ProgressView()
            } else if sent {
                Label("Sent", systemImage: "checkmark.circle.fill")
            } else {
                Text(title)
            }
        }
        .disabled(disabled || sending)
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
        errorText = nil
        defer { submitting = false }
        do {
            // Phone wins if both are filled — it's the more recent intent.
            if !trimmedPhone.isEmpty {
                try await auth.loginWithPhone(phone: trimmedPhone, code: trimmedCode)
            } else {
                try await auth.loginWithEmail(email: trimmedEmail, code: trimmedCode)
            }
            // Close the sheet; Home reacts to the new session and opens the list.
            dismiss()
        } catch {
            errorText = "Invalid or expired code. Try again."
            code = ""
        }
    }
}
