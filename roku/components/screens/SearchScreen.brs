sub init()
    m.kb = m.top.findNode("kb")
    m.buttons = m.top.findNode("buttons")
    m.grid = m.top.findNode("grid")
    m.message = m.top.findNode("message")
    m.heading = m.top.findNode("heading")

    m.buttons.buttons = ["< Back", "Search", "Clear"]
    m.buttons.observeField("buttonSelected", "onButton")
    m.grid.observeField("itemSelected", "onItemSelected")

    m.allShows = invalid
    m.results = []
    m.totalMatches = 0
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
        focusKeyboard()
    end if
end sub

sub runSearch()
    q = LCase(SafeStr(m.kb.text))
    if q = "" then return
    if m.top.authState = invalid or m.top.authState.loggedIn <> true
        showMessage("Sign in from the Account screen to search the club library.")
        return
    end if
    m.pendingQuery = q
    if m.allShows = invalid
        showMessage("Searching…")
        StartApi(m, { method: "GET", path: "/api/shows/all", tag: "all" }, "onAll")
    else
        applyFilter(q)
    end if
end sub

sub onAll(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if res.statusCode = 401
        showMessage("You're logged out — sign in again from the Account screen.")
        return
    end if
    m.allShows = []
    if res.json <> invalid and res.json.shows <> invalid
        for each s in res.json.shows
            m.allShows.push(s)
        end for
    end if
    applyFilter(m.pendingQuery)
end sub

sub applyFilter(q as string)
    ' De-dupe by title, keeping the richest copy (poster, else higher rating).
    best = {}
    order = []
    for each s in m.allShows
        if matches(s, q)
            key = LCase(SafeStr(s.title))
            if best[key] = invalid
                best[key] = s
                order.push(key)
            else
                best[key] = richer(best[key], s)
            end if
        end if
    end for

    m.results = []
    for each key in order
        m.results.push(best[key])
    end for

    ' A one-letter query matches most of the club library, and every match
    ' becomes a ContentNode the grid holds for the life of the screen. Cap what
    ' we render — well past what anyone scrolls — and say so in the heading
    ' rather than truncating silently.
    m.totalMatches = m.results.Count()
    if m.totalMatches > MaxResults()
        trimmed = []
        for i = 0 to MaxResults() - 1
            trimmed.push(m.results[i])
        end for
        m.results = trimmed
    end if
    renderResults()
end sub

function matches(s as object, q as string) as boolean
    if Instr(1, LCase(SafeStr(s.title)), q) > 0 then return true
    if Instr(1, LCase(SafeStr(s.network)), q) > 0 then return true
    if Instr(1, LCase(SafeStr(s.genres)), q) > 0 then return true
    ' actors is a JSON string on /api/shows(/all).
    actors = SafeStr(s.actors)
    if actors <> "" and Instr(1, LCase(actors), q) > 0 then return true
    return false
end function

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
    if m.totalMatches > m.results.Count()
        m.heading.text = "Search — first " + Stri(m.results.Count()).Trim() + " of " + Stri(m.totalMatches).Trim() + " matches"
    else
        m.heading.text = "Search"
    end if
    m.message.visible = false
    m.grid.visible = true
    root = CreateObject("roSGNode", "ContentNode")
    for each s in m.results
        root.appendChild(ShowCardNode(s))
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
    m.top.navigate = { action: "openDetail", data: { id: item.payload.id } }
end sub

' Move focus: keyboard <-> buttons <-> grid.
'
' Leaving the Keyboard depends on the Keyboard *declining* the key so it bubbles
' up to here, and Roku firmware differs on whether the bottom row passes Down
' along. Right and ✱ are the backups; ✱ is the only one no build claims, which
' is why the on-screen hint names it.
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
    m.buttons.setFocus(true)
end sub

sub focusGrid()
    m.zone = "grid"
    m.grid.setFocus(true)
end sub

' Cap on rendered matches — see applyFilter(). BrightScript has no `const`,
' so this follows the same function-returning-a-constant style as Globals.brs.
function MaxResults() as integer
    return 100
end function
