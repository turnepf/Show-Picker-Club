' Show Picker Club — Roku channel entry point.
' Creates the SceneGraph screen and hands control to MainScene.

sub Main(input as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)

    scene = screen.CreateScene("MainScene")
    screen.show()

    ' Park the launch args on the scene. Nothing reads them yet — deep linking
    ' is unimplemented and the manifest no longer claims it — but this is the
    ' seam a contentId/mediaType handler would hang off.
    if input <> invalid and type(input) = "roAssociativeArray"
        scene.launchArgs = input
    end if

    ' ---- Memory pressure ----
    '
    ' Certification flags a channel that never asks the device about memory,
    ' and it is right to: this one runs on hardware going back about eight
    ' years, where a poster row is a real fraction of the budget. Until now it
    ' *inferred* capability from the graphics platform and never asked, so a
    ' device under pressure got exactly the same treatment as an idle one.
    '
    ' Both monitors post to this loop's port. The channel reacts by dropping to
    ' the legacy profile — smaller artwork, no focus zoom, a lower search cap —
    ' which is the same set of economies the legacy tier already makes, applied
    ' for a different reason.
    memoryMonitor = CreateObject("roAppMemoryMonitor")
    if memoryMonitor <> invalid
        memoryMonitor.SetMessagePort(port)
        memoryMonitor.EnableMemoryWarningEvent(true)
        ' What this device actually allows the channel, and how close we are
        ' to it. Keys confirmed on a Streaming Stick 4K by iterating the array
        ' rather than assuming a field name — the ScrollableText lesson.
        limits = memoryMonitor.GetChannelMemoryLimit()
        foregroundMb = "?"
        if type(limits) = "roAssociativeArray" and limits.maxForegroundMemory <> invalid
            foregroundMb = Stri(Int(limits.maxForegroundMemory / 1024)).Trim()
        end if
        print "[showpicker] memory: "; memoryMonitor.GetMemoryLimitPercent(); "% of a "; foregroundMb; "MB foreground limit"

        ' Called so the channel has a live figure to reason about, and because
        ' certification checks that it is consulted at all.
        available = memoryMonitor.GetChannelAvailableMemory()
        if type(available) = "roAssociativeArray" and available.availableForegroundMemory <> invalid
            print "[showpicker] memory available="; Int(available.availableForegroundMemory / 1024); "MB"
        end if
    end if

    deviceInfo = CreateObject("roDeviceInfo")
    deviceInfo.SetMessagePort(port)
    deviceInfo.EnableLowGeneralMemoryEvent(true)

    while true
        msg = wait(0, port)
        t = type(msg)
        if t = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        else if t = "roAppMemoryNotificationEvent"
            ' Our own footprint is near the channel limit.
            if msg.isMemoryWarningReceived()
                print "[showpicker] memory warning - shedding to the legacy profile"
                scene.memoryPressure = true
            end if
        else if t = "roDeviceInfoEvent"
            ' The whole device is low, not just us. Same response.
            info = msg.GetInfo()
            if info <> invalid and info.Memory <> invalid and LCase(SafeStr(info.Memory)) <> "normal"
                print "[showpicker] device memory level="; info.Memory; " - shedding to the legacy profile"
                scene.memoryPressure = true
            end if
        end if
    end while
end sub
