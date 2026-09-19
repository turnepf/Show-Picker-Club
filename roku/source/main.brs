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

    while true
        msg = wait(0, port)
        if type(msg) = "roSGScreenEvent"
            if msg.isScreenClosed() then return
        end if
    end while
end sub
