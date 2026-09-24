' Show Picker Club — global helpers available to every component
' (all .brs files under source/ are compiled into the global scope).

function Config() as object
    return {
        baseUrl: "https://showpicker.club"
        platform: "roku"
        registrySection: "showpicker"
        cookieKey: "session_cookie"
    }
end function

' ---- Theme (ported from tvos/ShowPickerTV/Theme.swift) ----
function Theme() as object
    return {
        background: "0x0D0F14FF"
        surface:    "0x1C1F26FF"
        text:       "0xF5F7FAFF"
        muted:      "0xFFFFFF99"
        brand:      "0xF29C3DFF"
        watching:    "0x33C773FF"
        waiting:     "0x4299E6FF"
        recommending:"0xA866D9FF"
        next:        "0xF29C3DFF"
        listDefault: "0x737F9EFF"
    }
end function

' The four lists, in display order. rawValue != display label (matches ShowList.swift).
function ShowLists() as object
    t = Theme()
    return [
        { key: "watching",     title: "Watching", color: t.watching }
        { key: "waiting",      title: "Awaiting", color: t.waiting }
        { key: "recommending", title: "Loved",    color: t.recommending }
        { key: "next",         title: "Next Up",  color: t.next }
    ]
end function

function ListTitle(key as string) as string
    for each l in ShowLists()
        if l.key = key then return l.title
    end for
    return key
end function

function ListColor(key as string) as string
    for each l in ShowLists()
        if l.key = key then return l.color
    end for
    return Theme().listDefault
end function

' Deterministic fallback tile color from a title hash (mirrors tvOS tileColor).
function FallbackColor(title as dynamic) as string
    palette = ["0x3A5A78FF", "0x6B4A78FF", "0x2F6B5AFF", "0x784A4AFF", "0x4A5578FF", "0x78684AFF"]
    if title = invalid or title = "" then return palette[0]
    sum = 0
    s = LCase(title)
    for i = 1 to Len(s)
        sum = sum + Asc(Mid(s, i, 1))
    end for
    return palette[sum mod 6]
end function

' A network_url is only a real deep link if it is not a search/placeholder URL.
function IsRealUrl(u as dynamic) as boolean
    us = SafeStr(u)
    if us = "" then return false
    if Instr(1, us, "/search") > 0 then return false
    if Instr(1, us, "/s?") > 0 then return false
    if Instr(1, us, "?q=") > 0 then return false
    if Instr(1, us, "?query=") > 0 then return false
    return true
end function

' ---- Device capability tiering ----
'
' The channel has to stay usable on Rokus going back about eight years, and
' that is a genuinely different machine from a current box: the 2016-2018
' models draw through DirectFB with a small texture budget, anything current
' uses OpenGL. GetGraphicsPlatform() is Roku's own signal for that split — it
' has been available since OS 6, so it is safe to call on everything we
' support — and it is what picks the tier here.
'
' Everything that scales with device capability reads from this one profile,
' so there is a single place to change and a single place to look. The values
' are deliberately about *cost per pixel drawn*, not about features: no tier
' loses a screen, a list or an action.
function DeviceProfile() as object
    di = CreateObject("roDeviceInfo")
    platform = LCase(SafeStr(di.GetGraphicsPlatform()))
    legacy = (platform <> "opengl")

    ' Ask the device how it is doing rather than only inferring from what it
    ' is. A current box already under memory pressure should get the cheap
    ' treatment too, and certification expects a channel to consult this.
    level = LCase(SafeStr(di.GetGeneralMemoryLevel()))
    if level <> "" and level <> "normal" then legacy = true

    ' Build-time override — see the manifest. The Roku on hand for testing may
    ' well be a current one, and the legacy path is the half that most needs
    ' checking, so `node sideload.mjs --legacy` makes a modern device take it.
    #if FORCE_LEGACY
        legacy = true
    #end if

    if legacy then return LegacyProfile()

    return {
        tier:        "modern"
        platform:    platform
        model:       SafeStr(di.GetModelDisplayName())
        posterWidth: 342
        logoWidth:   154
        useBackdrop: true
        heroWidth:   780
        focusScale:  true
        maxResults:  100
    }
end function

' Legacy: a 720p-era GPU, so a card draws at ~187px and w185 is an almost exact
' match — a quarter of the texture memory of w342 and a quarter of the bytes
' over the wire. The backdrop is dropped in favour of the poster the card
' already warmed, and the focus scale goes away because re-scaling a bitmap
' every frame is the expensive thing on that stack.
'
' Its own function because it is reached two ways: by what the hardware is, and
' by the device reporting memory pressure while the channel is running.
function LegacyProfile() as object
    di = CreateObject("roDeviceInfo")
    return {
        tier:        "legacy"
        platform:    LCase(SafeStr(di.GetGraphicsPlatform()))
        model:       SafeStr(di.GetModelDisplayName())
        posterWidth: 185
        logoWidth:   92
        useBackdrop: false
        heroWidth:   342
        focusScale:  false
        maxResults:  40
    }
end function

' Read the profile MainScene cached on the global node, recomputing only if we
' are somewhere it never got set. Cheap enough to call per screen, too costly
' to call per card — pass the result down instead.
'
' Named ActiveProfile rather than Profile because BrightScript identifiers are
' case-insensitive: a global Profile() and a local `profile` are the same name,
' and the local silently wins inside that function.
function ActiveProfile(node as object) as object
    if node <> invalid and node.global <> invalid
        p = node.global.deviceProfile
        if p <> invalid and p.tier <> invalid then return p
    end if
    return DeviceProfile()
end function

' TMDB serves one image at several widths and the URL names the width
' (".../t/p/w500/abc.jpg"). The stored URLs are sized for the Apple apps,
' where a poster can fill an iPad; a Roku card draws at 280px and the oldest
' devices we support are texture-memory bound, so a 500px source costs real
' memory and real download time for pixels nobody sees.
'
' Only ever downsizes. A URL already smaller than the target is left alone —
' /api/title-search hands back w92 thumbnails, and rewriting those upward
' would make Search slower to serve worse-looking art. Anything that
' is not a TMDB sized-image URL is returned untouched.
function TmdbWidth(url as string, want as integer) as string
    marker = "image.tmdb.org/t/p/w"
    idx = Instr(1, url, marker)
    if idx = 0 then return url

    start = idx + Len(marker)
    digits = ""
    i = start
    while i <= Len(url)
        ch = Mid(url, i, 1)
        if ch >= "0" and ch <= "9"
            digits = digits + ch
            i = i + 1
        else
            exit while
        end if
    end while

    if digits = "" then return url
    if digits.ToInt() <= want then return url
    return Left(url, start - 1) + Stri(want).Trim() + Mid(url, i)
end function

' The line that says where a title streams *now*, or "" when there is nothing
' worth saying. A direct port of ShowPickerCore's `streamingNote` so the Roku
' card says the same thing the Apple clients say — see docs/INVARIANTS.md §20.
'
' A member's `network` is their own record and is never overwritten, so it
' drifts as licensing moves. Rather than correct their answer, state TMDB's:
'
'   - their network is among the services  -> "Also on Hulu" (the others)
'   - it is not, but TMDB names services   -> "Now on Paramount+"
'   - TMDB names nothing, or was never asked -> "" (no line)
'
' The last two cases must read alike: an empty `streaming_on` means TMDB was
' asked and found no subscription service, which is ordinary for a rental,
' while a missing one means nobody looked. Claiming the former on the latter
' asserts a fact never checked.
function StreamingNote(show as object) as string
    raw = SafeStr(show.streaming_on)
    if raw = "" then return ""

    services = []
    for each part in raw.Split(",")
        v = part.Trim()
        if v <> "" then services.push(v)
    end for
    if services.Count() = 0 then return ""

    mine = SafeStr(show.network).Trim()
    if mine <> ""
        others = []
        mineFound = false
        for each v in services
            if LCase(v) = LCase(mine)
                mineFound = true
            else
                others.push(v)
            end if
        end for
        if mineFound
            if others.Count() = 0 then return ""
            return "Also on " + joinStrings(others, ", ")
        end if
    end if
    return "Now on " + joinStrings(services, ", ")
end function

function joinStrings(arr as object, sep as string) as string
    if arr.Count() = 0 then return ""
    out = arr[0]
    for i = 1 to arr.Count() - 1
        out = out + sep + arr[i]
    end for
    return out
end function

' ---- Session cookie persistence (registry works on any thread) ----
function GetSessionCookie() as string
    cfg = Config()
    sec = CreateObject("roRegistrySection", cfg.registrySection)
    if sec.Exists(cfg.cookieKey) then return sec.Read(cfg.cookieKey)
    return ""
end function

sub SaveSessionCookie(token as string)
    cfg = Config()
    sec = CreateObject("roRegistrySection", cfg.registrySection)
    sec.Write(cfg.cookieKey, token)
    sec.Flush()
end sub

sub ClearSessionCookie()
    cfg = Config()
    sec = CreateObject("roRegistrySection", cfg.registrySection)
    if sec.Exists(cfg.cookieKey)
        sec.Delete(cfg.cookieKey)
        sec.Flush()
    end if
end sub

' Pull the session=<uuid> value out of a Set-Cookie header string.
function ExtractSessionFromSetCookie(sc as string) as string
    idx = Instr(1, sc, "session=")
    if idx = 0 then return ""
    rest = Mid(sc, idx + 8) ' len("session=") = 8
    semi = Instr(1, rest, ";")
    if semi > 0 then rest = Left(rest, semi - 1)
    return rest
end function

' Create + run an ApiTask. `req` is { method, path, body, tag }.
' `callback` is a function name in `host`'s scope observing the task's `result`.
' The host has to keep a reference or the node is collected mid-flight, so
' every callback must hand the task back via FinishApi().
function StartApi(host as object, req as object, callback as string) as object
    task = CreateObject("roSGNode", "ApiTask")
    task.observeField("result", callback)
    task.request = req
    if host.apiTasks = invalid then host.apiTasks = []
    host.apiTasks.push(task)
    task.control = "RUN"
    return task
end function

' Release a finished task. Call this from the top of every API callback: the
' callback is running, so the response has already been delivered and dropping
' the reference is safe. Without it, m.apiTasks grows for the life of the
' screen and each entry pins a whole response body — which is why repeatedly
' returning to Home (each visit re-fetches /api/members) kept climbing.
' Sweeping on the next StartApi instead would race: a task can reach state
' "done" before its callback is dispatched, and dropping it there loses the
' response.
sub FinishApi(host as object, ev as object)
    if host.apiTasks = invalid then return
    task = ev.getRoSGNode()
    task.unobserveField("result")
    keep = []
    for each t in host.apiTasks
        if not t.isSameNode(task) then keep.push(t)
    end for
    host.apiTasks = keep
end sub

' Toggle the shared loading spinner (declared once on MainScene) from any
' screen, so a slow API call has an obvious "something is happening"
' indicator instead of looking frozen.
sub SetBusy(host as object, v as boolean)
    scene = host.top.getScene()
    if scene = invalid then return
    spinner = scene.findNode("spinner")
    if spinner = invalid then return
    spinner.visible = v
    ' `control` drives the rotation; visibility alone leaves it a still image.
    if v
        spinner.control = "start"
    else
        spinner.control = "stop"
    end if
end sub

function SafeStr(v as dynamic) as string
    if v = invalid then return ""
    t = Type(v)
    if t = "roString" or t = "String" then return v
    if t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger" then return Stri(v).Trim()
    if t = "Float" or t = "roFloat" or t = "Double" or t = "roDouble" then return Str(v).Trim()
    if t = "Boolean" or t = "roBoolean"
        if v then return "true"
        return "false"
    end if
    return ""
end function
