import SwiftUI

// Self-service account deletion (App Store 5.1.1(v)), mirroring iOS:
// immediate hard delete, re-verified with a fresh emailed code so a stolen
// session alone can't destroy an account. Step 1 explains and emails the
// code; step 2 takes the code and pulls the trigger. On success the server
// has already destroyed the session, so we just clear local state — the
// Account tab falls back to the login screen.
struct DeleteAccountView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthStore
    @State private var codeSent = false
    @State private var code = ""
    @State private var working = false
    @State private var errorText: String?

    var body: some View {
        ZStack {
            Theme.background.ignoresSafeArea()

            VStack(spacing: 36) {
                Text("Delete Account")
                    .font(.system(size: 48, weight: .bold))
                    .foregroundColor(Theme.text)

                if !codeSent {
                    Text("This permanently deletes your account, all four lists, your subscriptions, and your calendar feed. It cannot be undone.")
                        .font(.system(size: 26))
                        .foregroundColor(Theme.text)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 900)

                    // Red label, not `role: .destructive` — see AccountView:
                    // the destructive role tints the fill and the text the
                    // same red, which leaves an unreadable pill.
                    Button {
                        Task { await sendCode() }
                    } label: {
                        if working {
                            ProgressView()
                        } else {
                            Text("Email me a deletion code")
                                .font(.system(size: 26, weight: .semibold))
                                .foregroundColor(.red)
                        }
                    }
                    .disabled(working)

                    Text("To confirm it's really you, we'll email a code to your address on file.")
                        .font(.system(size: 20))
                        .foregroundColor(Theme.muted)
                } else {
                    TextField("6-digit code", text: $code)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                        .font(.system(size: 30, weight: .semibold).monospacedDigit())
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 720)

                    Button {
                        Task { await confirmDelete() }
                    } label: {
                        if working {
                            ProgressView()
                        } else {
                            Text("Permanently delete my account")
                                .font(.system(size: 26, weight: .semibold))
                                .foregroundColor(.red)
                        }
                    }
                    .disabled(working || code.filter(\.isNumber).count < 6)

                    Text("We emailed a 6-digit code to your address on file. Entering it deletes everything immediately.")
                        .font(.system(size: 20))
                        .foregroundColor(Theme.muted)
                }

                Button("Cancel") { dismiss() }
                    .font(.system(size: 24))
                    .disabled(working)

                if let errorText {
                    Text(errorText)
                        .font(.system(size: 22))
                        .foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 900)
                }
            }
            .padding(.horizontal, 120)
        }
    }

    private func sendCode() async {
        working = true
        errorText = nil
        defer { working = false }
        do {
            let r = try await API.requestAccountDeleteCode()
            if r.sent == true {
                codeSent = true
            } else if r.error == "no_email" {
                errorText = "Your account has no email on file — contact the group owner to delete it."
            } else if r.error == "admin_must_demote_first" {
                errorText = "Admins can't self-delete — hand off admin first."
            } else if r.error == "rate_limited" {
                errorText = "Too many codes requested. Try again in an hour."
            } else {
                errorText = "Couldn't send the code. Try again."
            }
        } catch {
            errorText = "Network error. Try again."
        }
    }

    private func confirmDelete() async {
        working = true
        errorText = nil
        defer { working = false }
        do {
            let r = try await API.confirmAccountDelete(code: code.trimmingCharacters(in: .whitespaces))
            if r.deleted == true {
                auth.clearLocalSession()
                dismiss()
            } else if r.error == "rate_limited" {
                errorText = "Too many attempts. Try again later."
            } else {
                errorText = "Invalid or expired code."
                code = ""
            }
        } catch {
            errorText = "Network error. Try again."
        }
    }
}
