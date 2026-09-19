sub init()
    m.kb = m.top.findNode("kb")
    m.buttons = m.top.findNode("buttons")
    m.grid = m.top.findNode("grid")
    m.message = m.top.findNode("message")
    m.heading = m.top.findNode("heading")

    m.buttons.buttons = ["< Back", "Search", "Clear"]
    m.buttons.observeField("buttonSelected", "onButton")
    m.grid.observeField("itemSelected", "onItemSelected")

    m.results = []
    m.requested = 0
    m.truncated = false
    m.zone = "kb"
    m.kb.setFocus(true)
end sub

sub onButton()
    idx = m.buttons.buttonSelected
    if idx = 0
        m.top.navigate = { action: "back" }
    else if idx = 1
        runSearch()
    else if idx = 2
        m.kb.text = ""
        m.heading.text = "Search"
        focusKeyboard()
    end if
end sub

' The server does the filtering. This screen used to GET /api/shows/all in
' full, parse it and hold the whole club library in memory to filter locally —
' by far the heaviest thing the channel did, and the first thing that would
' fall over on a 512MB 2017 box as the club grows. `?q=` was added to that
' endpoint for exactly this; the device now receives matches instead of
' everything, and holds nothing between searches.
sub runSearch()
    q = SafeStr(m.kb.text)
    if q.Trim() = "" then return
    if m.top.authState = invalid or m.top.authState.loggedIn <> true
        showMessage("Sign in from the Account screen to search the club library.")
        return
    end if
    showMessage("Searching…")
    m.requested = MaxResults()
    enc = CreateObject("roUrlTransfer").Escape(q)
    path = "/api/shows/all?q=" + enc + "&limit=" + Stri(m.requested).Trim()
    StartApi(m, { method: "GET", path: path, tag: "search" }, "onAll")
end sub

sub onAll(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if res.statusCode = 401
        showMessage("You're logged out — sign in again from the Account screen.")
        return
    end if

    rows = []
    if res.json <> invalid and res.json.shows <> invalid
        for each s in res.json.shows
            rows.push(s)
        end for
    end if
    ' The server returns one row per member copy; a title two group-mates both
    ' hold comes back twice. Collapse to one card per title, keeping the
    ' richest copy. Bounded by the server's limit, so this is a short list.
    m.truncated = (rows.Count() >= m.requested)
    applyResults(rows)
end sub

' De-dupe by title, keeping the richest copy (poster, else higher rating).
sub applyResults(rows as object)
    best = {}
    order = []
    for each s in rows
        key = LCase(SafeStr(s.title))
        if best[key] = invalid
            best[key] = s
            order.push(key)
        else
            best[key] = richer(best[key], s)
        end if
    end for

    m.results = []
    for each key in order
        m.results.push(best[key])
    end for
    renderResults()
end sub

function richer(a as object, b as object) as object
    aHas = (SafeStr(a.poster_url) <> "")
    bHas = (SafeStr(b.poster_url) <> "")
    if aHas and not bHas then return a
    if bHas and not aHas then return b
    ra = SafeStr(a.rating).ToFloat()
    rb = SafeStr(b.rating).ToFloat()
    if rb > ra then return b
    return a
end function

sub renderResults()
    if m.results.Count() = 0
        m.heading.text = "Search"
        showMessage("No matches.")
        return
    end if
    ' The server caps the response, so a full page means "there may be more"
    ' rather than a count we can state. Say the true thing.
    if m.truncated
        m.heading.text = "Search — first " + Stri(m.results.Count()).Trim() + " matches, narrow your search for more"
    else
        m.heading.text = "Search"
    end if
    m.message.visible = false
    m.grid.visible = true
    root = CreateObject("roSGNode", "ContentNode")
    profile = ActiveProfile(m.top)
    for each s in m.results
        root.appendChild(ShowCardNode(s, profile))
    end for
    m.grid.content = root
    focusGrid()
end sub

sub showMessage(text as string)
    m.message.text = text
    m.message.visible = true
    m.grid.visible = false
end sub

sub onItemSelected()
    idx = m.grid.itemSelected
    if idx = invalid then return
    item = m.grid.content.getChild(idx)
    if item = invalid then return
    m.top.navigate = { action: "openDetail", data: { id: item.payload.id, seed: item.payload } }
end sub

' Move focus: keyboard <-> buttons <-> grid.
'
' Leaving the Keyboard depends on the Keyboard *declining* the key so it bubbles
' up to here, and Roku firmware differs on whether the bottom row passes Down
' along. Right and the ✱/options key are the backups. Down is confirmed
' working on a Streaming Stick 4K (OS 15.3); the others stay for the older
' hardware this channel targets, where the firmware may differ.
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    hasResults = (m.results.Count() > 0)

    if m.zone = "kb"
        if key = "down" or key = "options"
            focusButtons()
            return true
        else if key = "right" and hasResults
            focusGrid()
            return true
        end if
    else if m.zone = "buttons"
        if key = "up" or key = "options"
            focusKeyboard()
            return true
        else if key = "right" and hasResults
            focusGrid()
            return true
        else if key = "down"
            ' Swallow it. This group is horizontal, so Down has no business
            ' moving between buttons — and the button it moved onto was Clear,
            ' which throws away what was just typed. Left/Right navigate.
            return true
        end if
    else if m.zone = "grid"
        if key = "left" or key = "options"
            focusButtons()
            return true
        end if
    end if
    return false
end function

sub focusKeyboard()
    m.zone = "kb"
    m.kb.setFocus(true)
end sub

sub focusButtons()
    m.zone = "buttons"
    ' Land on the search action rather than wherever the group was last left —
    ' leaving the keyboard means "I've typed it", and Clear is a trap there.
    ' focusButton has to be set *after* setFocus: assigning it to a group that
    ' does not yet hold focus is overridden when focus arrives.
    m.buttons.setFocus(true)
    m.buttons.focusButton = 1
end sub

sub focusGrid()
    m.zone = "grid"
    m.grid.setFocus(true)
end sub

' Cap on rendered matches — see applyFilter(). Lower on legacy hardware, where
' each card is texture memory the device has much less of.
function MaxResults() as integer
    return ActiveProfile(m.top).maxResults
end function
