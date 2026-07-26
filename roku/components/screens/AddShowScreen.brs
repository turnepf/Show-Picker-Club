sub init()
    m.kb = m.top.findNode("kb")
    m.buttons = m.top.findNode("buttons")
    m.grid = m.top.findNode("grid")
    m.message = m.top.findNode("message")

    m.buttons.buttons = ["Search TMDB", "Clear"]
    m.buttons.observeField("buttonSelected", "onButton")
    m.grid.observeField("itemSelected", "onItemSelected")

    m.results = []
    m.zone = "kb"
    m.kb.setFocus(true)
end sub

sub onButton()
    idx = m.buttons.buttonSelected
    if idx = 0
        runSearch()
    else if idx = 1
        m.kb.text = ""
        m.zone = "kb"
        m.kb.setFocus(true)
    end if
end sub

sub runSearch()
    q = SafeStr(m.kb.text)
    if q = "" then return
    if m.top.authState = invalid or m.top.authState.loggedIn <> true
        showMessage("Sign in from the Account screen to add shows.")
        return
    end if
    showMessage("Searching…")
    enc = CreateObject("roUrlTransfer").Escape(q)
    StartApi(m, { method: "GET", path: "/api/title-search?q=" + enc, tag: "titlesearch" }, "onResults")
end sub

sub onResults(ev as object)
    res = ev.getRoSGNode().result
    if res.statusCode = 401
        showMessage("You're logged out — sign in again from the Account screen.")
        return
    end if
    m.results = []
    if res.json <> invalid and res.json.results <> invalid
        for each r in res.json.results
            m.results.push(r)
        end for
    end if
    if m.results.Count() = 0
        showMessage("No results.")
        return
    end if
    m.message.visible = false
    m.grid.visible = true
    root = CreateObject("roSGNode", "ContentNode")
    for each r in m.results
        yr = SafeStr(r.year)
        root.appendChild(MakeCardContent({
            title: SafeStr(r.title) + iif(yr <> "", Chr(10) + "(" + yr + ")", "")
            posterUrl: SafeStr(r.poster_url)
            fallbackColor: FallbackColor(r.title)
            payload: r
        }))
    end for
    m.grid.content = root
    m.zone = "grid"
    m.grid.setFocus(true)
end sub

function iif(cond as boolean, a as string, b as string) as string
    if cond then return a
    return b
end function

sub onItemSelected()
    idx = m.grid.itemSelected
    if idx = invalid then return
    item = m.grid.content.getChild(idx)
    if item = invalid then return
    m.pending = item.payload
    promptForList()
end sub

sub promptForList()
    dialog = CreateObject("roSGNode", "Dialog")
    dialog.title = "Add “" + SafeStr(m.pending.title) + "” to…"
    labels = []
    for each l in ShowLists()
        labels.push(l.title)
    end for
    dialog.buttons = labels
    dialog.observeField("buttonSelected", "onListPicked")
    m.dialog = dialog
    m.top.getScene().dialog = dialog
end sub

sub onListPicked()
    idx = m.dialog.buttonSelected
    lists = ShowLists()
    if idx < 0 or idx >= lists.Count() then return
    listKey = lists[idx].key
    m.top.getScene().dialog = invalid

    r = m.pending
    mediaType = SafeStr(r.media_type)
    if mediaType = "" then mediaType = SafeStr(r.mediaType)
    body = {
        title: SafeStr(r.title)
        list: listKey
        movie: iifi(mediaType = "movie", 1, 0)
        full_series: 0
    }
    if r.tmdb_id <> invalid then body.tmdb_id = r.tmdb_id
    if mediaType <> "" then body.tmdb_type = mediaType

    m.addedList = listKey
    StartApi(m, { method: "POST", path: "/api/shows", body: FormatJson(body), tag: "add" }, "onAdded")
end sub

function iifi(cond as boolean, a as integer, b as integer) as integer
    if cond then return a
    return b
end function

sub onAdded(ev as object)
    res = ev.getRoSGNode().result
    dialog = CreateObject("roSGNode", "Dialog")
    if res.ok
        dialog.title = "Added"
        dialog.message = "“" + SafeStr(m.pending.title) + "” added to " + ListTitle(m.addedList) + "."
    else if res.statusCode = 401
        dialog.title = "Signed out"
        dialog.message = "Sign in again from the Account screen."
    else
        dialog.title = "Couldn't add"
        dialog.message = "Please try again."
    end if
    dialog.buttons = ["OK"]
    m.top.getScene().dialog = dialog
end sub

sub showMessage(text as string)
    m.message.text = text
    m.message.visible = true
    m.grid.visible = false
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.zone = "kb" and key = "down"
        m.zone = "buttons" : m.buttons.setFocus(true) : return true
    else if m.zone = "buttons" and key = "up"
        m.zone = "kb" : m.kb.setFocus(true) : return true
    else if m.zone = "buttons" and key = "right" and m.results.Count() > 0
        m.zone = "grid" : m.grid.setFocus(true) : return true
    else if m.zone = "grid" and key = "left"
        m.zone = "buttons" : m.buttons.setFocus(true) : return true
    end if
    return false
end function
