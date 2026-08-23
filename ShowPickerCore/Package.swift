// swift-tools-version:5.9
import PackageDescription

// Shared, UI-free core (models + list enum) used by every Apple target —
// iPhone, Apple TV, and Apple Watch — so the data layer is defined once.
let package = Package(
    name: "ShowPickerCore",
    platforms: [
        .iOS(.v16),
        .tvOS(.v16),
        .watchOS(.v9),
        // Mac Catalyst builds as iOS, so this line isn't for the shipping app —
        // it's for `swift build`/`swift test` on a Mac, which otherwise assumes
        // 10.13 and rejects the modern Keychain API in SessionStore.
        .macOS(.v13),
    ],
    products: [
        .library(name: "ShowPickerCore", targets: ["ShowPickerCore"]),
    ],
    targets: [
        .target(name: "ShowPickerCore"),
        // Runs on Linux CI (`swift test`), which is why everything in this
        // package stays Foundation-only and UI-free. See SessionScope.swift.
        .testTarget(name: "ShowPickerCoreTests", dependencies: ["ShowPickerCore"]),
    ]
)
