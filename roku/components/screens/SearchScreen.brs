sub init()
    m.kb = m.top.findNode("kb")
    m.buttons = m.top.findNode("buttons")
    m.grid = m.top.findNode("grid")
    m.message = m.top.findNode("message")

    m.buttons.buttons = ["< Back", "Search", "Clear"]
    m.buttons.observeField("buttonSelected", "onButton")
    m.grid.observeField("itemSelected", "onItemSelected")

    m.allShows = invalid
    m.results = []
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
        m.zone = "kb"
        m.kb.setFocus(true)
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
        showMessage("No matches.")
        return
    end if
    m.message.visible = false
    m.grid.visible = true
    root = CreateObject("roSGNode", "ContentNode")
    for each s in m.results
        root.appendChild(ShowCardNode(s))
    end for
    m.grid.content = root
    m.zone = "grid"
    m.grid.setFocus(true)
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
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.zone = "kb" and key = "down"
        m.zone = "buttons"
        m.buttons.setFocus(true)
        return true
    else if m.zone = "buttons" and key = "up"
        m.zone = "kb"
        m.kb.setFocus(true)
        return true
    else if m.zone = "buttons" and key = "right" and m.results.Count() > 0
        m.zone = "grid"
        m.grid.setFocus(true)
        return true
    else if m.zone = "grid" and key = "left"
        m.zone = "buttons"
        m.buttons.setFocus(true)
        return true
    end if
    return false
end function
