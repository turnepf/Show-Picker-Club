import SwiftUI
import AuthenticationServices

// Log in / sign up: identifier-first, one decision per screen. Step 1 picks a
// channel (Apple / email / phone), step 2 takes the identifier, step 3 the
// 6-digit code (auto-submitting), and step 4 — new signups only, when the
// server answers needs_name — asks for a name before creating the account.
// With self-enroll off server-side, unknown identities simply get the old
// "not linked to a member" error and nothing else changes.
struct LoginView: View {
    private enum Step { case choose, email, phone, code, name }
    private enum Channel { case email, phone, apple }

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthStore
    @State private var step: Step = .choose
    @State private var channel: Channel = .email
    @State private var phone = ""
    @State private var email = ""
    @State private var code = ""
    @State private var fullName = ""
    @State private var appleToken: String?
    @State private var sending = false
    @State private var submitting = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                switch step {
                case .choose: chooseSection
                case .email: emailSection
                case .phone: phoneSection
                case .code: codeSection
                case .name: nameSection
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red).font(.callout) }
                }
            }
            .navigationTitle("Log in or sign up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                if step != .choose {
                    ToolbarItem(placement: .topBarLeading) { Button("Back") { goBack() } }
                }
            }
            .overlay { if submitting { ProgressView().controlSize(.large) } }
        }
    }

    // MARK: Steps

    private var chooseSection: some View {
        Section {
            SignInWithAppleButton(.continue) { request in
                request.requestedScopes = [.email, .fullName]
            } onCompletion: { result in
                Task { await handleApple(result) }
            }
            .signInWithAppleButtonStyle(.black)
            .frame(height: 46)
            .listRowInsets(EdgeInsets())
            .disabled(submitting)

            Button {
                show(.email, channel: .email)
            } label: {
                Label("Continue with email", systemImage: "envelope")
            }
            Button {
                show(.phone, channel: .phone)
            } label: {
                Label("Continue with phone", systemImage: "message")
            }
        } footer: {
            // App Review likes the agreement being visible at the door.
            Text("By continuing, you agree to the [Terms](https://showpicker.club/terms) and acknowledge the [Privacy Policy](https://showpicker.club/privacy).")
        }
    }

    private var emailSection: some View {
        Section {
            TextField("you@example.com", text: $email)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.continue)
                .onSubmit { Task { await sendEmailCode() } }
            continueButton(title: "Continue", disabled: email.trimmingCharacters(in: .whitespaces).isEmpty) {
                await sendEmailCode()
            }
        } header: {
            Text("What's your email?")
        } footer: {
            Text("We'll email you a 6-digit code.")
        }
    }

    private var phoneSection: some View {
        Section {
            TextField("(336) 555-1234", text: $phone)
                .keyboardType(.phonePad)
                .textContentType(.telephoneNumber)
            continueButton(title: "Text me a code", disabled: phone.trimmingCharacters(in: .whitespaces).isEmpty) {
                await sendPhoneCode()
            }
        } header: {
            Text("What's your phone number?")
        } footer: {
            Text("Phone login is for members with a number on file. New here? Go back and use Apple or email.")
        }
    }

    private var codeSection: some View {
        Section {
            TextField("6-digit code", text: $code)
                .keyboardType(.numberPad)
                .textContentType(.oneTimeCode)
                .font(.title3.monospacedDigit())
                .multilineTextAlignment(.center)
                .onChange(of: code) { _, newValue in
                    // Auto-submit as soon as a full 6-digit code is in.
                    if newValue.filter(\.isNumber).count == 6 && !submitting {
                        Task { await submitCode() }
                    }
                }
        } header: {
            Text("Enter your code")
        } footer: {
            Text(channel == .phone
                 ? "We texted a code to \(phone). It logs you in automatically."
                 : "We sent a code to \(email). It logs you in automatically.")
        }
    }

    private var nameSection: some View {
        Section {
            TextField("First and last name", text: $fullName)
                .textContentType(.name)
                .submitLabel(.done)
                .onSubmit { Task { await submitName() } }
            continueButton(title: "Create my account",
                           disabled: fullName.trimmingCharacters(in: .whitespaces).count < 2) {
                await submitName()
            }
        } header: {
            Text("What's your name?")
        } footer: {
            Text("Other members see your first name (plus a last initial if two members share it).")
        }
    }

    @ViewBuilder
    private func continueButton(title: String, disabled: Bool,
                                action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            if sending { ProgressView() } else { Text(title).frame(maxWidth: .infinity) }
        }
        .disabled(disabled || sending || submitting)
    }

    private func show(_ next: Step, channel newChannel: Channel? = nil) {
        errorText = nil
        if let c = newChannel { channel = c }
        step = next
    }

    private func goBack() {
        // From the code screen, back to whichever identifier screen sent it;
        // from anywhere else, back to the channel chooser.
        errorText = nil
        code = ""
        switch step {
        case .code where channel == .email: step = .email
        case .code where channel == .phone: step = .phone
        default: step = .choose
        }
    }

    // MARK: Actions

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
            // Apple shares the name only on the very FIRST authorization —
            // pass it through so new signups usually skip the name screen.
            let name = [cred.fullName?.givenName, cred.fullName?.familyName]
                .compactMap { $0 }.joined(separator: " ")
            appleToken = token
            channel = .apple
            submitting = true
            defer { submitting = false }
            do {
                switch try await auth.loginWithApple(identityToken: token,
                                                     fullName: name.isEmpty ? nil : name) {
                case .success: dismiss()
                case .needsName: show(.name)
                }
            } catch API.APIError.badResponse(401) {
                errorText = "That Apple ID isn't linked to a member yet. Pick \"Share My Email\" with the address the owner has on file, or continue with email."
            } catch API.APIError.badResponse(429) {
                errorText = "Signups are paused right now. Try again tomorrow."
            } catch {
                // 404/403/5xx or no network — distinct from an unrecognized member.
                errorText = "Couldn't reach sign-in. Check your connection, or continue with email."
            }
        case .failure(let error):
            // Silently ignore a user-initiated cancel; surface anything else.
            if (error as? ASAuthorizationError)?.code != .canceled {
                errorText = "Apple sign-in failed. Try again."
            }
        }
    }

    private func sendPhoneCode() async {
        sending = true
        errorText = nil
        defer { sending = false }
        do {
            _ = try await API.requestSmsCode(phone: phone.trimmingCharacters(in: .whitespaces))
            show(.code)
        } catch {
            errorText = "Couldn't send. Check the number and try again."
        }
    }

    private func sendEmailCode() async {
        let trimmed = email.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("@") else {
            errorText = "Enter a valid email first."
            return
        }
        sending = true
        errorText = nil
        defer { sending = false }
        do {
            _ = try await API.requestEmailCode(email: trimmed)
            show(.code)
        } catch {
            errorText = "Couldn't send. Check the address and try again."
        }
    }

    private func submitCode() async {
        let trimmedCode = code.trimmingCharacters(in: .whitespaces)
        submitting = true
        defer { submitting = false }
        do {
            if channel == .phone {
                try await auth.loginWithPhone(phone: phone.trimmingCharacters(in: .whitespaces),
                                              code: trimmedCode)
                dismiss()
            } else {
                switch try await auth.loginWithEmail(email: email.trimmingCharacters(in: .whitespaces),
                                                     code: trimmedCode) {
                case .success: dismiss()
                case .needsName: show(.name)   // valid signup code, no account yet
                }
            }
        } catch API.APIError.badResponse(429) {
            errorText = "Too many attempts. Try again in 15 minutes."
            code = ""
        } catch {
            errorText = "Invalid or expired code. Try again."
            code = ""
        }
    }

    private func submitName() async {
        let name = fullName.trimmingCharacters(in: .whitespaces)
        guard name.count >= 2 else { return }
        submitting = true
        defer { submitting = false }
        do {
            if channel == .apple, let token = appleToken {
                switch try await auth.loginWithApple(identityToken: token, fullName: name) {
                case .success: dismiss()
                case .needsName: errorText = "Something went wrong — try Apple sign-in again."
                }
            } else {
                try await auth.enroll(email: email.trimmingCharacters(in: .whitespaces),
                                      code: code.trimmingCharacters(in: .whitespaces),
                                      fullName: name)
                dismiss()
            }
        } catch API.APIError.badResponse(409) {
            errorText = "That email already belongs to a member — go back and log in."
        } catch API.APIError.badResponse(429) {
            errorText = "Signups are paused right now. Try again tomorrow."
        } catch API.APIError.badResponse(403) {
            errorText = "Signups are closed right now."
        } catch {
            errorText = "Couldn't create your account. Try again."
        }
    }
}
