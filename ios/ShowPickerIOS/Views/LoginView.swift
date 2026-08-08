import SwiftUI
import AuthenticationServices
import UIKit

// Log in / sign up: identifier-first, one decision per screen. Step 1 picks a
// channel (Apple / email / phone), step 2 takes the identifier, step 3 the
// 6-digit code (auto-submitting), and step 4 — new signups only, when the
// server answers needs_name — asks for a name before creating the account.
// With self-enroll off server-side, unknown identities simply get the old
// "not linked to a member" error and nothing else changes.
struct LoginView: View {
    private enum Step { case choose, email, phone, code, name, passkeyOffer }
    private enum Channel { case email, phone, apple }

    // "Not now" on the passkey offer, as a reference-date timestamp. Declining
    // has to survive the session — the guidance on passkey upgrade prompts is
    // that a decline is answered, not re-asked on the next sign-in. Re-offered
    // after this long, because getting members onto passkeys is what makes
    // retiring the code channels possible (docs/PRODUCT.md#backlog); a decline
    // that lasts forever quietly gives that up.
    @AppStorage("passkeyOfferDeclinedAt") private var passkeyOfferDeclinedAt = 0.0
    private static let reofferAfter: TimeInterval = 30 * 24 * 60 * 60

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
                case .passkeyOffer: passkeyOfferSection
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red).font(.callout) }
                }
            }
            .navigationTitle(step == .passkeyOffer ? "You're in" : "Log in or sign up")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                // On the passkey offer they're already signed in, so there is
                // nothing to cancel and nowhere to go back to — the only exits
                // are "Add a passkey" and "Not now", both of which close the
                // sheet. Anything else here would read as a way to undo the
                // login it just completed.
                if step != .passkeyOffer {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    if step != .choose {
                        ToolbarItem(placement: .topBarLeading) { Button("Back") { goBack() } }
                    }
                }
            }
            .overlay { if submitting { ProgressView().controlSize(.large) } }
        }
    }

    // MARK: Steps

    private var chooseSection: some View {
        Section {
            // First, because for a returning member it's one tap and Face ID —
            // no code to wait for and nothing to type. It only works once a
            // passkey has been added from inside a session, so everything
            // below it stays exactly as it was for anyone who hasn't.
            Button {
                Task { await signInWithPasskey() }
            } label: {
                Label("Sign in with a passkey", systemImage: "person.badge.key")
            }
            .disabled(submitting)

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
            Text("Log in with a number already on your account")
        } footer: {
            // This warning used to sit quietly under the field, and people
            // walked straight past it: /auth/request-code deliberately answers
            // "success" for an unknown number (so nobody can discover which
            // numbers belong to members), the app took that at face value, and
            // the next screen promised a text that was never sent. Someone
            // waited for a code that could not arrive. The endpoint's silence
            // is correct; saying this before they tap is the fix.
            Text("**Texting only works if you've already added this number to your account.** If you're new, or you've never added a number, go back and use Apple or email instead.")
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
            // Phrased as "if" for the phone, not "we texted": the server won't
            // tell us whether that number is on file, so claiming we sent one
            // is a claim we can't back. The second sentence is the way out for
            // the person staring at a code that is never going to arrive.
            Text(channel == .phone
                 ? "If \(phone) is on your account, a code is on its way — it logs you in automatically. No text? That number isn't on file. Go back and use Apple or email."
                 : "We sent a code to \(email). It logs you in automatically.")
        }
    }

    // Requires a first *and* last token — a single word leaves last_name
    // NULL server-side (functions/_shared/enroll.js#hasFirstAndLast).
    private var hasFirstAndLast: Bool {
        fullName.split(whereSeparator: { $0.isWhitespace }).count >= 2
    }

    private var nameSection: some View {
        Section {
            TextField("First and last name", text: $fullName)
                .textContentType(.name)
                .submitLabel(.done)
                .onSubmit { Task { await submitName() } }
            continueButton(title: "Create my account",
                           disabled: !hasFirstAndLast) {
                await submitName()
            }
        } header: {
            Text("What's your name?")
        } footer: {
            Text("Other members see your first name (plus a last initial if two members share it).")
        }
    }

    // Offered once a code sign-in has already succeeded — the moment the
    // member has just proved who they are and just felt the friction this
    // removes. Never a gate: they're signed in either way, and both buttons
    // close the sheet.
    private var passkeyOfferSection: some View {
        Section {
            continueButton(title: "Add a passkey", disabled: false) {
                await acceptPasskeyOffer()
            }
            Button("Not now") { declinePasskeyOffer() }
                .disabled(sending || submitting)
        } header: {
            Text("Skip the code next time")
        } footer: {
            Text("A passkey signs you in with Face ID or Touch ID — no code to wait for. It's stored in your iCloud Keychain, so this covers your iPhone, iPad and Mac. You can add or remove one later from the account menu.")
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

    // MARK: Finishing a sign-in

    /// Every successful non-passkey sign-in ends here. Offers a passkey when
    /// the member has none and hasn't recently said no; otherwise closes the
    /// sheet exactly as before.
    private func finishLogin() async {
        guard await shouldOfferPasskey() else {
            dismiss()
            return
        }
        errorText = nil
        step = .passkeyOffer
    }

    private func shouldOfferPasskey() async -> Bool {
        // Not after Sign in with Apple. That's already one tap and Face ID —
        // a passkey would save them nothing, so the offer would be a screen
        // added to an instant flow. The codes are what a passkey replaces, and
        // an Apple member who later falls back to a code gets asked then.
        if channel == .apple { return false }

        let declined = Date(timeIntervalSinceReferenceDate: passkeyOfferDeclinedAt)
        if passkeyOfferDeclinedAt > 0, Date().timeIntervalSince(declined) < Self.reofferAfter {
            return false
        }
        // Passkeys sync through the iCloud Keychain, so one added on the
        // member's iPhone already covers their iPad — "does this account have
        // any" is the question worth asking, not "does this device".
        // A failure here (offline, older server) means don't interrupt.
        guard let existing = try? await API.passkeys() else { return false }
        return existing.isEmpty
    }

    private func acceptPasskeyOffer() async {
        errorText = nil
        sending = true
        defer { sending = false }
        do {
            try await auth.registerPasskey(label: UIDevice.current.name)
            dismiss()
        } catch PasskeyAuthenticator.Failure.canceled {
            // Backing out of the system sheet is an answer. Record it and let
            // them go — they're signed in, and re-asking here would be the
            // nagging this prompt is supposed to avoid.
            declinePasskeyOffer()
        } catch {
            // Keep them on the step so "Not now" is still there, but say what
            // happened rather than closing on a silent failure.
            errorText = API.failureLine(error, action: "add the passkey")
        }
    }

    private func declinePasskeyOffer() {
        passkeyOfferDeclinedAt = Date().timeIntervalSinceReferenceDate
        dismiss()
    }

    // MARK: Actions

    private func signInWithPasskey() async {
        errorText = nil
        submitting = true
        defer { submitting = false }
        do {
            try await auth.loginWithPasskey()
            dismiss()
        } catch PasskeyAuthenticator.Failure.canceled {
            // Dismissed the sheet, or had no passkey to offer. Either way
            // they're still looking at the other options — say nothing.
        } catch PasskeyAuthenticator.Failure.noCredentials {
            errorText = "No passkey for Show Picker on this device. Sign in another way, then add one from the account menu."
        } catch let e as API.APIError where e.status == 401 {
            // Verified locally but the server didn't know the credential —
            // the passkey outlived the account, or it was removed.
            errorText = "That passkey isn't registered any more. Sign in another way and add a new one."
        } catch let e as API.APIError where e.status == 429 {
            errorText = "Too many attempts. Try again in 15 minutes."
        } catch {
            errorText = "Couldn't reach sign-in. Check your connection, or continue with email."
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
                case .success: await finishLogin()
                case .needsName: show(.name)
                }
            } catch let e as API.APIError where e.status == 400 {
                // Apple shared only one name component (rare) — the server
                // needs a first and last name, so fall to the name screen
                // with what we have pre-filled rather than a dead-end error.
                show(.name)
                fullName = name
                errorText = "Apple only shared part of your name — add your last name too."
            } catch let e as API.APIError where e.status == 401 {
                errorText = "That Apple ID isn't linked to a member yet. Pick \"Share My Email\" with the address the owner has on file, or continue with email."
            } catch let e as API.APIError where e.status == 429 {
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
        } catch let e as API.APIError where e.status == 400 {
            // The only failure the number itself can cause (invalid_phone).
            // Unknown-but-valid numbers return success on purpose.
            errorText = "That doesn't look like a valid phone number. Check it and try again."
        } catch let e as API.APIError where e.status == 429 {
            errorText = "Too many codes requested. Try again in an hour."
        } catch {
            errorText = "Couldn't send the code. Check your connection and try again."
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
        } catch let e as API.APIError where e.status == 429 {
            errorText = "Too many codes requested. Try again in an hour."
        } catch let e as API.APIError where e.status == 502 {
            // The server was reached and the mail provider refused the address
            // — distinct from no network, and not something retrying fixes.
            errorText = "We couldn't send an email to that address. Try a different one, or go back and continue with Apple."
        } catch {
            // Unknown addresses return success on purpose, so a failure here
            // is delivery or connectivity — never the address being unknown.
            errorText = "Couldn't send the code. Check your connection and try again."
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
                await finishLogin()
            } else {
                switch try await auth.loginWithEmail(email: email.trimmingCharacters(in: .whitespaces),
                                                     code: trimmedCode) {
                case .success: await finishLogin()
                case .needsName: show(.name)   // valid signup code, no account yet
                }
            }
        } catch let e as API.APIError where e.status == 429 {
            errorText = "Too many attempts. Try again in 15 minutes."
            code = ""
        } catch let e as API.APIError where e.status == 401 {
            errorText = "Invalid or expired code. Try again."
            code = ""
        } catch {
            // Connectivity/server trouble — the code may still be good, keep it.
            errorText = "Couldn't reach sign-in. Check your connection and try again."
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
                case .success: await finishLogin()
                case .needsName: errorText = "Something went wrong — try Apple sign-in again."
                }
            } else {
                try await auth.enroll(email: email.trimmingCharacters(in: .whitespaces),
                                      code: code.trimmingCharacters(in: .whitespaces),
                                      fullName: name)
                await finishLogin()
            }
        } catch let e as API.APIError where e.status == 400 {
            errorText = "Enter your first and last name."
        } catch let e as API.APIError where e.status == 409 {
            errorText = "That email already belongs to a member — go back and log in."
        } catch let e as API.APIError where e.status == 429 {
            errorText = "Signups are paused right now. Try again tomorrow."
        } catch let e as API.APIError where e.status == 403 {
            errorText = "Signups are closed right now."
        } catch {
            errorText = "Couldn't create your account. Try again."
        }
    }
}
