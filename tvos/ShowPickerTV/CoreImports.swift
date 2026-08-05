// Re-export the shared core so every file in this app sees Show, Actor, and
// ShowList (and their response wrappers) without importing the package by hand.
@_exported import ShowPickerCore

// SwiftUI declares its own `Group`, so the model can't be written bare in type
// position anywhere in this target. One internal alias, declared where the
// re-export happens — a fileprivate one per file would be less visible than the
// internal properties that use it (GroupTileTV.group), which is an error.
typealias ClubGroup = ShowPickerCore.Group
