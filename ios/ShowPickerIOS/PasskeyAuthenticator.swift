import AuthenticationServices
import UIKit

// AuthenticationServices, wrapped so the two passkey flows read as ordinary
// async calls. ASAuthorizationController is delegate-based and one-shot, so
// each call gets its own instance and the delegate callbacks resume a
// continuation.
//
// The relying party is the website, not the app (see functions/_shared/
// passkeys.js): `webcredentials:showpicker.club` in the entitlements plus the
// webcredentials block in the AASA file is what lets the app use a credential
// scoped to the domain. One passkey therefore works on iPhone, iPad and Mac
// through the iCloud Keychain, and would work on the web too if the web ever
// wanted a sign-in again.
@MainActor
final class PasskeyAuthenticator: NSObject {
    static let relyingPartyIdentifier = "showpicker.club"

    enum Failure: Error {
        /// The member dismissed the system sheet. Not an error to report —
        /// they changed their mind.
        case canceled
        /// The device has no passkey for this account (or the member picked
        /// "no thanks" at the AutoFill prompt).
        case noCredentials
        /// The server sent something we couldn't use.
        case malformedChallenge
        case failed(String)
    }

    private var continuation: CheckedContinuation<ASAuthorization, Error>?

    /// Create a passkey for `userName` / `userID`, returning what the server
    /// needs to verify and store it.
    func register(challenge: String, userName: String, userID: String) async throws
        -> (credentialID: String, attestationObject: String, clientDataJSON: String) {
        guard let challengeData = Data(base64urlEncoded: challenge),
              let userIDData = Data(base64urlEncoded: userID) else {
            throw Failure.malformedChallenge
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: Self.relyingPartyIdentifier)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challengeData, name: userName, userID: userIDData)
        // The server refuses a credential without the user-verified flag, so
        // ask for it rather than discovering the mismatch on the round trip.
        request.userVerificationPreference = .required

        let authorization = try await perform(request)
        guard let credential = authorization.credential
                as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
              let attestation = credential.rawAttestationObject else {
            throw Failure.failed("This device didn't return a usable passkey.")
        }
        return (
            credentialID: credential.credentialID.base64urlEncodedString(),
            attestationObject: attestation.base64urlEncodedString(),
            clientDataJSON: credential.rawClientDataJSON.base64urlEncodedString()
        )
    }

    /// Sign in with an existing passkey. No identifier is passed: the
    /// credentials are discoverable, so the device offers whichever passkeys
    /// it holds for showpicker.club and the member picks one.
    func assert(challenge: String) async throws
        -> (credentialID: String, authenticatorData: String, clientDataJSON: String, signature: String) {
        guard let challengeData = Data(base64urlEncoded: challenge) else {
            throw Failure.malformedChallenge
        }

        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(
            relyingPartyIdentifier: Self.relyingPartyIdentifier)
        let request = provider.createCredentialAssertionRequest(challenge: challengeData)
        request.userVerificationPreference = .required

        let authorization = try await perform(request)
        guard let credential = authorization.credential
                as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw Failure.failed("That wasn't a passkey.")
        }
        return (
            credentialID: credential.credentialID.base64urlEncodedString(),
            authenticatorData: credential.rawAuthenticatorData.base64urlEncodedString(),
            clientDataJSON: credential.rawClientDataJSON.base64urlEncodedString(),
            signature: credential.signature.base64urlEncodedString()
        )
    }

    // MARK: Plumbing

    private func perform(_ request: ASAuthorizationRequest) async throws -> ASAuthorization {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<ASAuthorization, Error>) {
        // ASAuthorizationController calls back exactly once, but a nil-out
        // here means a double callback can't resume a spent continuation.
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(with: result)
    }
}

// AuthenticationServices calls these on the main queue, so they resolve the
// continuation inline via assumeIsolated. Hopping through a Task instead would
// mean carrying a non-Sendable ASAuthorization across an actor boundary for no
// benefit, and would let the caller's `defer` run before the result landed.
extension PasskeyAuthenticator: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(controller: ASAuthorizationController,
                                             didCompleteWithAuthorization authorization: ASAuthorization) {
        MainActor.assumeIsolated { finish(.success(authorization)) }
    }

    nonisolated func authorizationController(controller: ASAuthorizationController,
                                             didCompleteWithError error: Error) {
        let mapped: Error
        switch (error as? ASAuthorizationError)?.code {
        case .canceled:
            // Covers both "member tapped cancel" and "there were no passkeys
            // to offer" — AuthenticationServices reports them the same way,
            // and neither deserves a red error line.
            mapped = Failure.canceled
        case .notHandled, .unknown:
            mapped = Failure.noCredentials
        default:
            mapped = Failure.failed(error.localizedDescription)
        }
        MainActor.assumeIsolated { finish(.failure(mapped)) }
    }
}

extension PasskeyAuthenticator: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first { $0.activationState == .foregroundActive }
                ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
        }
    }
}

// MARK: - base64url
//
// WebAuthn speaks base64url; Foundation only does standard base64. The
// server's encoder (functions/_shared/webauthn.js) is the mirror of this.
extension Data {
    init?(base64urlEncoded string: String) {
        var s = string.replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/")
        let remainder = s.count % 4
        if remainder > 0 { s += String(repeating: "=", count: 4 - remainder) }
        guard let data = Data(base64Encoded: s) else { return nil }
        self = data
    }

    func base64urlEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
