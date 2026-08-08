import SwiftUI
import AuthenticationServices

// tvOS sign-in, identifier-first like iOS and the web: step 1 picks a channel
// (Apple / email / phone), step 2 takes the identifier, step 3 the 6-digit
// code (auto-submitting), and step 4 — new signups only, when the server
// answers needs_name — asks for a name before creating the account. Lives in
// the Account tab; on success RootTabView flips over to My Shows.
//
// Sign in with Apple on tvOS authorizes with an Apple ID already signed into
// the box, so on a shared TV the code flows stay the way for everyone else in
// the room to sign in as themselves.
struct LoginView: View {
    private enum Step { case choose, email, phone, code, name }
    private enum Channel { case email, phone, apple }

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
    @State private var appleCoordinator = AppleSignInCoordinator()

    var body: some View {
        // Menu (the remote's back gesture) steps back through the flow instead
        // of falling through to the tab bar and out of the app. Attached only
        // on sub-steps so Menu still leaves normally from the chooser.
        if step == .choose {
            content
        } else {
            content.onExitCommand { goBack() }
        }
    }

    private var content: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 36) {
                Text("Show Picker Club")
                    .font(.system(size: 56, weight: .bold))
                    .foregroundColor(Theme.text)

                Text(subtitle)
                    .font(.system(size: 26))
                    .foregroundColor(Theme.muted)

                Group {
                    switch step {
                    case .choose: chooseStep
                    case .email: emailStep
                    case .phone: phoneStep
                    case .code: codeStep
                    case .name: nameStep
                    }
                }
                .frame(maxWidth: 720)

                if step != .choose {
                    Button("Back") { goBack() }
                        .font(.system(size: 24))
                        .disabled(submitting)
                }

                if let errorText {
                    Text(errorText)
                        .font(.system(size: 22))
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 900)
                } else if let hint = footerHint {
                    Text(hint)
                        .font(.system(size: 20))
                        .foregroundColor(Theme.muted)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 900)
                }
            }
            .padding(.horizontal, 120)
            .overlay { if submitting { ProgressView().controlSize(.large) } }
        }
        // Signed in (any path: code, Apple, enroll) — clear the flow so a
        // later sign-out lands back on the chooser, not a stale "enter your
        // code" screen. The tab keeps this view's state alive across the
        // whole signed-in session.
        .onChange(of: auth.memberSlug) { _, slug in
            if slug != nil { resetFlow() }
        }
    }

    private func resetFlow() {
        step = .choose
        channel = .email
        phone = ""
        email = ""
        code = ""
        fullName = ""
        appleToken = nil
        errorText = nil
    }

    // MARK: Step copy

    private var subtitle: String {
        switch step {
        case .choose: return "Sign in to see the club's lists"
        case .email: return "What's your email?"
        case .phone: return "What's your phone number?"
        case .code: return "Enter your code"
        case .name: return "What's your name?"
        }
    }

    private var footerHint: String? {
        switch step {
        case .choose:
            return "By continuing, you agree to the Terms and Privacy Policy at showpicker.club/terms and showpicker.club/privacy."
        case .email:
            return "We'll email you a 6-digit code."
        case .phone:
            return "Phone login is for members with a number on file. New here? Go back and use Apple or email."
        case .code:
            return channel == .phone
                ? "We texted a code to \(phone). It logs you in automatically."
                : "We sent a code to \(email). It logs you in automatically."
        case .name:
            return "Other members see your first name (plus a last initial if two members share it)."
        }
    }

    // MARK: Steps

    private var chooseStep: some View {
        VStack(spacing: 24) {
            // A plain focusable button driving ASAuthorizationController —
            // SwiftUI's SignInWithAppleButton doesn't respond to the Siri
            // Remote's select on tvOS.
            Button {
                Task { await startAppleSignIn() }
            } label: {
                Label("Continue with Apple", systemImage: "applelogo")
                    .font(.system(size: 26, weight: .semibold))
                    .frame(width: 500)
            }
            .disabled(submitting)

            Button {
                show(.email, channel: .email)
            } label: {
                Label("Continue with email", systemImage: "envelope")
                    .font(.system(size: 26, weight: .semibold))
                    .frame(width: 500)
            }
            .disabled(submitting)

            Button {
                show(.phone, channel: .phone)
            } label: {
                Label("Continue with phone", systemImage: "message")
                    .font(.system(size: 26, weight: .semibold))
                    .frame(width: 500)
            }
            .disabled(submitting)
        }
    }

    private var emailStep: some View {
        VStack(spacing: 24) {
            TextField("you@example.com", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            continueButton(title: "Continue",
                           disabled: email.trimmingCharacters(in: .whitespaces).isEmpty) {
                await sendEmailCode()
            }
        }
    }

    private var phoneStep: some View {
        VStack(spacing: 24) {
            TextField("(336) 555-1234", text: $phone)
                .textContentType(.telephoneNumber)
                .keyboardType(.phonePad)
            continueButton(title: "Text me a code",
                           disabled: phone.trimmingCharacters(in: .whitespaces).isEmpty) {
                await sendPhoneCode()
            }
        }
    }

    private var codeStep: some View {
        TextField("6-digit code", text: $code)
            .textContentType(.oneTimeCode)
            .keyboardType(.numberPad)
            .font(.system(size: 30, weight: .semibold).monospacedDigit())
            .multilineTextAlignment(.center)
            .onChange(of: code) { _, newValue in
                // Auto-submit once a full 6-digit code is entered.
                if newValue.filter(\.isNumber).count == 6 && !submitting {
                    Task { await submitCode() }
                }
            }
    }

    // Requires a first *and* last token — a single word leaves last_name
    // NULL server-side (functions/_shared/enroll.js#hasFirstAndLast).
    private var hasFirstAndLast: Bool {
        fullName.split(whereSeparator: { $0.isWhitespace }).count >= 2
    }

    private var nameStep: some View {
        VStack(spacing: 24) {
            TextField("First and last name", text: $fullName)
                .textContentType(.name)
            continueButton(title: "Create my account",
                           disabled: !hasFirstAndLast) {
                await submitName()
            }
        }
    }

    @ViewBuilder
    private func continueButton(title: String, disabled: Bool,
                                action: @escaping () async -> Void) -> some View {
        Button {
            Task { await action() }
        } label: {
            if sending {
                ProgressView()
            } else {
                Text(title)
                    .font(.system(size: 26, weight: .semibold))
                    .frame(maxWidth: 360)
            }
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

    private func startAppleSignIn() async {
        do {
            let authorization = try await appleCoordinator.signIn()
            await handleApple(.success(authorization))
        } catch {
            await handleApple(.failure(error))
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
                case .success: break   // RootTabView jumps to My Shows
                case .needsName: show(.name)
                }
            } catch API.APIError.badResponse(400) {
                // Apple shared only one name component (rare) — the server
                // needs a first and last name, so fall to the name screen
                // with what we have pre-filled rather than a dead-end error.
                show(.name)
                fullName = name
                errorText = "Apple only shared part of your name — add your last name too."
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
        } catch API.APIError.badResponse(400) {
            // The only failure the number itself can cause (invalid_phone).
            // Unknown-but-valid numbers return success on purpose.
            errorText = "That doesn't look like a valid phone number. Check it and try again."
        } catch API.APIError.badResponse(429) {
            errorText = "Too many codes requested. Try again in an hour."
        } catch {
            errorText = "Couldn't send the code. Check the connection and try again."
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
        } catch API.APIError.badResponse(429) {
            errorText = "Too many codes requested. Try again in an hour."
        } catch API.APIError.badResponse(502) {
            // The server was reached and the mail provider refused the address
            // — blaming the TV's connection sent App Review looking for a
            // network problem that wasn't there.
            errorText = "We couldn't send an email to that address. Try a different one, or go back and continue with Apple."
        } catch {
            // Unknown addresses return success on purpose, so a failure here
            // is delivery or connectivity — never the address being unknown.
            errorText = "Couldn't send the code. Check the connection and try again."
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
            } else {
                switch try await auth.loginWithEmail(email: email.trimmingCharacters(in: .whitespaces),
                                                     code: trimmedCode) {
                case .success: break
                case .needsName: show(.name)   // valid signup code, no account yet
                }
            }
        } catch API.APIError.badResponse(429) {
            errorText = "Too many attempts. Try again in 15 minutes."
            code = ""
        } catch API.APIError.badResponse(401) {
            errorText = "Invalid or expired code. Try again."
            code = ""
        } catch {
            // Connectivity/server trouble — the code may still be good, keep it.
            errorText = "Couldn't reach sign-in. Check the connection and try again."
        }
    }

    private func submitName() async {
        let name = fullName.trimmingCharacters(in: .whitespaces)
        guard hasFirstAndLast else {
            errorText = "Enter your first and last name."
            return
        }
        submitting = true
        defer { submitting = false }
        do {
            if channel == .apple, let token = appleToken {
                switch try await auth.loginWithApple(identityToken: token, fullName: name) {
                case .success: break
                case .needsName: errorText = "Something went wrong — try Apple sign-in again."
                }
            } else {
                try await auth.enroll(email: email.trimmingCharacters(in: .whitespaces),
                                      code: code.trimmingCharacters(in: .whitespaces),
                                      fullName: name)
            }
        } catch API.APIError.badResponse(400) {
            errorText = "Enter your first and last name."
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

// Drives the system Sign in with Apple sheet on tvOS from a plain button.
// Bridges ASAuthorizationController's delegate callbacks into async/await.
@MainActor
final class AppleSignInCoordinator: NSObject, ASAuthorizationControllerDelegate,
                                    ASAuthorizationControllerPresentationContextProviding {
    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    func signIn() async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { cont in
            continuation = cont
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email, .fullName]
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        continuation?.resume(returning: authorization)
        continuation = nil
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        if let window = scenes.compactMap(\.keyWindow).first ?? scenes.flatMap(\.windows).first {
            return window
        }
        // Unreachable in practice — the sign-in button that triggers this is
        // itself in an on-screen window. Satisfies the non-optional return
        // without the bare UIWindow() initializer (deprecated in tvOS 26).
        guard let scene = scenes.first else {
            preconditionFailure("Sign in with Apple requested with no connected window scene")
        }
        return UIWindow(windowScene: scene)
    }
}
