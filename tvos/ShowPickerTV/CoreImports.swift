// Re-export the shared core so every file in this app sees Show, Actor, and
// ShowList (and their response wrappers) without importing the package by hand.
@_exported import ShowPickerCore

// SwiftUI declares its own `Group`, so the model can't be written bare in type
// position anywhere in this target. One internal alias, declared where the
// re-export happens, rather than a private one per file: GroupTileTV is
// internal and has a `group` property, so a fileprivate alias made its type
// less visible than the property — which the compiler reported as "failed to
// produce diagnostic" rather than as the access-level error it is.
typealias ClubGroup = ShowPickerCore.Group
