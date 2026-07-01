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
    ],
    products: [
        .library(name: "ShowPickerCore", targets: ["ShowPickerCore"]),
    ],
    targets: [
        .target(name: "ShowPickerCore"),
    ]
)
