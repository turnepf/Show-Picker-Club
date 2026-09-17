sub init()
    m.heading = m.top.findNode("heading")
    m.rows = m.top.findNode("rows")
    m.message = m.top.findNode("message")
    m.rows.showRowLabel = [true, true, true, true]
    m.rows.observeField("rowItemSelected", "onRowSelected")
    m.rowMeta = []
    m.loaded = false
end sub

' authState is set by MainScene right after the member field, so start here.
sub onAuthReady()
    load()
end sub

sub onReturn()
    ' Coming back from a detail screen — refresh the lists (a move may have changed them).
    if m.slug <> invalid and m.slug <> "" and loggedIn() then fetchShows()
end sub

function loggedIn() as boolean
    return (m.top.authState <> invalid and m.top.authState.loggedIn = true)
end function

sub load()
    if m.loaded then return
    m.loaded = true

    member = m.top.member
    label = ""
    m.slug = ""
    if member <> invalid
        label = SafeStr(member.display_name)
        if label = "" then label = SafeStr(member.name)
        m.slug = SafeStr(member.slug)
    end if
    m.heading.text = label

    if not loggedIn()
        m.message.text = "Sign in from the Account screen to see members' lists."
        m.message.visible = true
        return
    end if
    fetchShows()
end sub

sub fetchShows()
    m.message.text = "Loading…"
    m.message.visible = true
    SetBusy(m, true)
    StartApi(m, { method: "GET", path: "/api/shows?member=" + m.slug, tag: "shows" }, "onShows")
end sub

sub onShows(ev as object)
    SetBusy(m, false)
    res = ev.getRoSGNode().result
    if res.statusCode = 401
        m.message.text = "You're logged out — sign in again from the Account screen."
        m.message.visible = true
        return
    end if
    shows = []
    if res.json <> invalid and res.json.shows <> invalid
        for each s in res.json.shows
            shows.push(s)
        end for
    end if
    buildRows(shows)
end sub

sub buildRows(shows as object)
    root = CreateObject("roSGNode", "ContentNode")
    m.rowMeta = []

    for each listDef in ShowLists()
        inList = []
        for each s in shows
            if SafeStr(s.list) = listDef.key then inList.push(s)
        end for
        if inList.Count() > 0
            sortShows(inList, listDef.key)
            row = root.createChild("ContentNode")
            row.title = listDef.title + tallySuffix(inList)
            for each s in inList
                row.appendChild(ShowCardNode(s))
            end for
            m.rowMeta.push(listDef.key)
        end if
    end for

    if m.rowMeta.Count() = 0
        m.message.text = "No shows in any list yet."
        m.message.visible = true
        m.rows.content = CreateObject("roSGNode", "ContentNode")
        return
    end if
    m.message.visible = false
    m.rows.content = root
    m.rows.setFocus(true)
end sub

' "    ·    Netflix (12) · Hulu (3)" appended to the row label (mirrors NetworkTally).
function tallySuffix(shows as object) as string
    counts = {}
    order = []
    for each s in shows
        n = SafeStr(s.network)
        if n = "" then n = "Other"
        if counts[n] = invalid
            counts[n] = 0
            order.push(n)
        end if
        counts[n] = counts[n] + 1
    end for
    if order.Count() = 0 then return ""
    joined = ""
    for i = 0 to order.Count() - 1
        n = order[i]
        piece = n + " (" + Stri(counts[n]).Trim() + ")"
        if i = 0 then joined = piece else joined = joined + " · " + piece
    end for
    return "    ·    " + joined
end function

' Sort in place, mirroring tvOS MemberView.sorted.
sub sortShows(arr as object, listKey as string)
    hasManual = false
    for each s in arr
        if s.sort_order <> invalid then hasManual = true
    end for
    for i = 1 to arr.Count() - 1
        cur = arr[i]
        j = i - 1
        while j >= 0 and compareShows(arr[j], cur, listKey, hasManual) > 0
            arr[j + 1] = arr[j]
            j = j - 1
        end while
        arr[j + 1] = cur
    end for
end sub

function ratingOf(s as object) as float
    if s.rating = invalid then return 0.0
    return SafeStr(s.rating).ToFloat()
end function

function ratingCompareDesc(a as object, b as object) as integer
    ra = ratingOf(a) : rb = ratingOf(b)
    if ra > rb then return -1
    if ra < rb then return 1
    return 0
end function

function compareShows(a as object, b as object, listKey as string, hasManual as boolean) as integer
    if hasManual
        oa = 999999 : ob = 999999
        if a.sort_order <> invalid then oa = a.sort_order
        if b.sort_order <> invalid then ob = b.sort_order
        if oa <> ob then return oa - ob
        return ratingCompareDesc(a, b)
    end if

    if listKey = "watching" or listKey = "waiting"
        da = SafeStr(a.next_season_date)
        db = SafeStr(b.next_season_date)
        if da <> "" and db = "" then return -1
        if da = "" and db <> "" then return 1
        if da <> "" and db <> ""
            if da < db then return -1
            if da > db then return 1
        end if
        return ratingCompareDesc(a, b)
    end if
    return ratingCompareDesc(a, b)
end function

sub onRowSelected()
    sel = m.rows.rowItemSelected
    if sel = invalid then return
    item = m.rows.content.getChild(sel[0]).getChild(sel[1])
    if item = invalid then return
    m.top.navigate = { action: "openDetail", data: { id: item.payload.id } }
end sub
