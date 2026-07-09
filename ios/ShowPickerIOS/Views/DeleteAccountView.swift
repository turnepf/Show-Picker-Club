import SwiftUI

// Self-service account deletion (App Store 5.1.1(v)): immediate hard delete,
// re-verified with a fresh emailed code so a stolen session alone can't
// destroy an account. Step 1 explains and emails the code; step 2 takes the
// code and pulls the trigger. On success the server has already destroyed the
// session, so we just clear local state and fall back to logged-out.
struct DeleteAccountView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var auth: AuthStore
    @State private var codeSent = false
    @State private var code = ""
    @State private var working = false
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Form {
                if !codeSent {
                    Section {
                        Text("This permanently deletes your account, all four lists, your subscriptions, and your calendar feed. **It cannot be undone.**")
                        Button(role: .destructive) {
                            Task { await sendCode() }
                        } label: {
                            if working { ProgressView() } else { Text("Email me a deletion code") }
                        }
                        .disabled(working)
                    } footer: {
                        Text("To confirm it's really you, we'll email a code to your address on file.")
                    }
                } else {
                    Section {
                        TextField("6-digit code", text: $code)
                            .keyboardType(.numberPad)
                            .textContentType(.oneTimeCode)
                            .font(.title3.monospacedDigit())
                            .multilineTextAlignment(.center)
                        Button(role: .destructive) {
                            Task { await confirmDelete() }
                        } label: {
                            if working { ProgressView() } else { Text("Permanently delete my account") }
                        }
                        .disabled(working || code.filter(\.isNumber).count < 6)
                    } header: {
                        Text("Enter the deletion code")
                    } footer: {
                        Text("We emailed a 6-digit code to your address on file. Entering it deletes everything immediately.")
                    }
                }
                if let err = errorText {
                    Section { Text(err).foregroundStyle(.red).font(.callout) }
                }
            }
            .navigationTitle("Delete Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
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
                await auth.clearLocalSession()
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
