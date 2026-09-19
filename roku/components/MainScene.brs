' Root scene: owns the view stack, the shared auth state, and nav routing.

sub init()
    m.viewHolder = m.top.findNode("viewHolder")
    m.spinner = m.top.findNode("spinner")
    m.stack = []
    m.apiTasks = []
    m.auth = { loggedIn: false, slug: invalid, email: invalid, isAdmin: false, checked: false }

    ' Resolve the device tier once, before any screen is built, and park it on
    ' the global node so every component reads the same answer. The print is
    ' the only way to see which tier a device landed in — it shows up on the
    ' telnet debug console during sideload testing.
    profile = DeviceProfile()
    m.global.addFields({ deviceProfile: profile })
    print "[showpicker] device tier="; profile.tier; " graphics="; profile.platform; " model="; profile.model

    ' Show Home immediately (Trending is public); confirm any stored session in parallel.
    showHome()
    checkAuth()
end sub

' The device says memory is tight. Drop to the legacy profile — the same
' economies the low-end tier already makes (smaller artwork, no per-frame
' focus scaling, a lower search cap), applied because the device asked rather
' than because of what it is. One-way for the session: a channel that
' oscillates between profiles would thrash the texture cache it is trying to
' relieve.
sub onMemoryPressure()
    if m.top.memoryPressure <> true then return
    p = m.global.deviceProfile
    if p <> invalid and p.tier = "legacy" then return
    m.global.deviceProfile = LegacyProfile()
    print "[showpicker] profile downgraded to legacy under memory pressure"
end sub

' ---------- Auth ----------
sub checkAuth()
    if GetSessionCookie() = ""
        m.auth.checked = true
        broadcastAuth()
        return
    end if
    StartApi(m, { method: "GET", path: "/auth/check", tag: "check" }, "onAuthChecked")
end sub

sub onAuthChecked(ev as object)
    FinishApi(m, ev)
    task = ev.getRoSGNode()
    res = task.result
    j = res.json
    if j <> invalid and j.authenticated = true
        m.auth.loggedIn = true
        m.auth.slug = SafeStr(j.member)
        m.auth.email = SafeStr(j.email)
        m.auth.isAdmin = (j.is_admin = true)
    else if j <> invalid
        ' The server actually answered "authenticated: false" — sign out for real.
        m.auth.loggedIn = false
        m.auth.slug = invalid
        ClearSessionCookie()
    end if
    ' j = invalid means the request itself failed (timeout, dropped connection,
    ' bad body) rather than the server saying no — leave the stored cookie and
    ' current auth state alone so a network hiccup doesn't force a logout.
    m.auth.checked = true
    broadcastAuth()
end sub

' Push the current auth state into every live screen that wants it.
sub broadcastAuth()
    for each node in m.stack
        if node.hasField("authState") then node.authState = m.auth
    end for
end sub

' ---------- View stack ----------
sub pushView(node as object)
    node.observeField("navigate", "onChildNavigate")
    if node.hasField("authState") then node.authState = m.auth
    m.viewHolder.appendChild(node)
    if m.stack.Count() > 0 then topOf(m.stack).visible = false
    m.stack.push(node)
    node.setFocus(true)
end sub

sub popView()
    if m.stack.Count() <= 1 then return
    top = m.stack.pop()
    m.viewHolder.removeChild(top)
    prev = topOf(m.stack)
    prev.visible = true
    if prev.hasField("authState") then prev.authState = m.auth
    if prev.hasField("didReturn") then prev.didReturn = true
    prev.setFocus(true)
end sub

function topOf(arr as object) as object
    return arr[arr.Count() - 1]
end function

sub replaceRoot(node as object)
    ' Clear the whole stack and start fresh (used on login/logout).
    for each n in m.stack
        m.viewHolder.removeChild(n)
    end for
    m.stack = []
    pushView(node)
end sub

' ---------- Routing ----------
sub onChildNavigate(ev as object)
    msg = ev.getData()
    if msg = invalid then return
    action = SafeStr(msg.action)

    if action = "openMember"
        node = CreateObject("roSGNode", "MemberScreen")
        node.member = msg.data
        pushView(node)
    else if action = "openDetail"
        node = CreateObject("roSGNode", "DetailScreen")
        ' Seed before showId: setting showId fires the request, and the seed is
        ' what lets the screen draw while that request is in flight.
        if msg.data.seed <> invalid then node.seed = msg.data.seed
        node.showId = msg.data.id
        pushView(node)
    else if action = "openSearch"
        pushView(CreateObject("roSGNode", "SearchScreen"))
    else if action = "openAdd"
        pushView(CreateObject("roSGNode", "AddShowScreen"))
    else if action = "openAccount"
        pushView(CreateObject("roSGNode", "AccountScreen"))
    else if action = "back"
        popView()
    else if action = "authChanged"
        ' A screen changed auth (login/logout). Re-check then rebuild Home.
        checkAuth()
        showHome()
    end if
end sub

sub showHome()
    node = CreateObject("roSGNode", "HomeScreen")
    replaceRoot(node)
end sub

' ---------- Global back handling ----------
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "back"
        if m.stack.Count() > 1
            popView()
            return true
        end if
        ' At Home: let the system exit the channel.
        return false
    end if
    return false
end function
