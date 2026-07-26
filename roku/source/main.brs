' Show Picker Club — Roku channel entry point.
' Creates the SceneGraph screen and hands control to MainScene.

sub Main(input as dynamic)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.setMessagePort(port)

    scene = screen.CreateScene("MainScene")
    screen.show()

    ' Support deep-link / re-launch input if the channel is relaunched.
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
