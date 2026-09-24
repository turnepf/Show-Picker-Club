sub init()
    m.heading = m.top.findNode("heading")
    m.nav = m.top.findNode("nav")
    m.rows = m.top.findNode("rows")
    m.message = m.top.findNode("message")
    m.rows.showRowLabel = [true, true, true, true]
    m.rows.observeField("rowItemSelected", "onRowSelected")
    m.nav.buttons = ["< Back"]
    m.nav.observeField("buttonSelected", "onNavButton")
    m.rowMeta = []
    m.loaded = false
    m.zone = "nav"
    ' nav is always present, even while shows are still loading — don't wait
    ' on data for there to be a way back.
    m.nav.setFocus(true)
end sub

sub onNavButton()
    m.top.navigate = { action: "back" }
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "down" and m.zone = "nav"
        if m.rowMeta <> invalid and m.rowMeta.Count() > 0
            m.zone = "rows"
            m.rows.setFocus(true)
            return true
        end if
    else if key = "up" and m.zone = "rows"
        if m.rows.rowItemFocused <> invalid and m.rows.rowItemFocused[0] = 0
            m.zone = "nav"
            m.nav.setFocus(true)
            return true
        end if
    end if
    return false
end function

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
    FinishApi(m, ev)
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
    profile = ActiveProfile(m.top)

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
                row.appendChild(ShowCardNode(s, profile))
            end for
            m.rowMeta.push(listDef.key)
        end if
    end for

    if m.rowMeta.Count() = 0
        ' On your own lists, point at where adding lives now.
        if m.slug = SafeStr(m.top.authState.slug)
            m.message.text = "Nothing on your lists yet. Use Search on the Home screen to find a show and add it."
        else
            m.message.text = "No shows in any list yet."
        end if
        m.message.visible = true
        m.rows.content = CreateObject("roSGNode", "ContentNode")
        return
    end if
    m.message.visible = false
    m.rows.content = root
    m.zone = "rows"
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
'
' The comparison runs O(n^2) times under the insertion sort below, so each key
' is computed once up front rather than inside the comparison. It used to
' re-read `rating` and re-parse it to a float on every comparison — on a
' 200-title list that is ~20,000 string-to-float conversions for a screen the
' viewer is waiting on, which is plainly slow on a 2017 Roku and free to avoid.
' The ordering is unchanged.
sub sortShows(arr as object, listKey as string)
    hasManual = false
    for each s in arr
        if s.sort_order <> invalid then hasManual = true
    end for

    rows = []
    for each s in arr
        order = 999999
        if s.sort_order <> invalid then order = s.sort_order
        rows.push({
            show:   s
            order:  order
            rating: ratingOf(s)
            date:   SafeStr(s.next_season_date)
        })
    end for

    byDate = (listKey = "watching" or listKey = "waiting")
    for i = 1 to rows.Count() - 1
        cur = rows[i]
        j = i - 1
        while j >= 0 and compareRows(rows[j], cur, byDate, hasManual) > 0
            rows[j + 1] = rows[j]
            j = j - 1
        end while
        rows[j + 1] = cur
    end for

    for i = 0 to rows.Count() - 1
        arr[i] = rows[i].show
    end for
end sub

function ratingOf(s as object) as float
    if s.rating = invalid then return 0.0
    return SafeStr(s.rating).ToFloat()
end function

' Compare two decorated rows. Reads precomputed fields only — no parsing.
function compareRows(a as object, b as object, byDate as boolean, hasManual as boolean) as integer
    if hasManual
        if a.order <> b.order then return a.order - b.order
        return ratingCompareDesc(a, b)
    end if

    if byDate
        if a.date <> "" and b.date = "" then return -1
        if a.date = "" and b.date <> "" then return 1
        if a.date <> "" and b.date <> ""
            if a.date < b.date then return -1
            if a.date > b.date then return 1
        end if
        return ratingCompareDesc(a, b)
    end if
    return ratingCompareDesc(a, b)
end function

function ratingCompareDesc(a as object, b as object) as integer
    if a.rating > b.rating then return -1
    if a.rating < b.rating then return 1
    return 0
end function

sub onRowSelected()
    sel = m.rows.rowItemSelected
    if sel = invalid then return
    item = m.rows.content.getChild(sel[0]).getChild(sel[1])
    if item = invalid then return
    m.top.navigate = { action: "openDetail", data: { id: item.payload.id, seed: item.payload } }
end sub
