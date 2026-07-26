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
function StartApi(host as object, req as object, callback as string) as object
    task = CreateObject("roSGNode", "ApiTask")
    task.observeField("result", callback)
    task.request = req
    if host.apiTasks = invalid then host.apiTasks = []
    host.apiTasks.push(task)
    task.control = "RUN"
    return task
end function

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
