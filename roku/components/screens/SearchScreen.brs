' Find a Show — search is how you add. Mirrors tvos/ShowPickerTV/SearchView.
'
' What you type goes to TMDB (/api/title-search) and every result can be added
' to one of your lists. There used to be a separate Add Show screen for that,
' with this screen searching only the copies group-mates already had, so a
' title nobody you knew had just wasn't findable here. The club now rides along
' as context: your own copies come first ("On your lists", archived too — their
' detail screen is where Restore lives), and a focused TMDB result names the
' group-mates who have it.

sub init()
    m.kb = m.top.findNode("kb")
    m.buttons = m.top.findNode("buttons")
    m.rows = m.top.findNode("rows")
    m.message = m.top.findNode("message")
    m.caption = m.top.findNode("caption")
    m.debounce = m.top.findNode("debounce")

    m.buttons.buttons = ["< Back", "Search", "Clear"]
    m.buttons.observeField("buttonSelected", "onButton")
    m.rows.showRowLabel = [true, true]
    m.rows.observeField("rowItemSelected", "onItemSelected")
    m.rows.observeField("rowItemFocused", "onItemFocused")
    m.kb.observeField("text", "onTextChanged")
    m.top.observeField("focusedChild", "onFocusedChild")
    m.debounce.observeField("fire", "onDebounce")

    ' Your own library (slimmed, see slimOwn) and, per query, the group-mates'
    ' copies matching it. Either failing to load just leaves that context out.
    m.mine = []
    m.mineSlug = ""
    m.group = []
    m.hits = []
    m.activeQuery = ""
    m.searching = false
    m.searchFailed = false
    m.focusOnResults = false
    m.rowMeta = []

    m.zone = "kb"
    m.kb.setFocus(true)
    render()
end sub

sub onAuth()
    if not loggedIn()
        m.mine = []
        m.mineSlug = ""
        m.group = []
        m.hits = []
        render()
        return
    end if
    slug = SafeStr(m.top.authState.slug)
    if slug <> m.mineSlug then loadMine()
    ' Signing in elsewhere while text is already typed: search it now.
    if currentQuery() <> m.activeQuery then runSearch()
    render()
end sub

' Back from a detail screen — a move, archive or restore there changes which
' list an own copy sits on.
sub onReturn()
    if loggedIn() then loadMine()
end sub

function loggedIn() as boolean
    return (m.top.authState <> invalid and m.top.authState.loggedIn = true)
end function

function currentQuery() as string
    return SafeStr(m.kb.text).Trim()
end function

sub onButton()
    idx = m.buttons.buttonSelected
    if idx = 0
        m.top.navigate = { action: "back" }
    else if idx = 1
        ' Explicit search (or a retry after the catalog failed): results take
        ' focus when they land, which a debounced search never does — it would
        ' pull focus off the keyboard mid-word.
        m.debounce.control = "stop"
        m.focusOnResults = true
        runSearch()
    else if idx = 2
        m.kb.text = ""
        focusKeyboard()
    end if
end sub

' Every keystroke restarts the timer; only the pause after typing searches.
sub onTextChanged()
    m.debounce.control = "stop"
    q = currentQuery()
    if Len(q) < 2
        m.activeQuery = ""
        m.hits = []
        m.group = []
        m.searching = false
        m.searchFailed = false
        render()
        return
    end if
    ' Own copies are local, so that row can follow the typing immediately.
    render()
    m.debounce.control = "start"
end sub

sub onDebounce()
    runSearch()
end sub

' ---------- Data ----------

sub loadMine()
    slug = SafeStr(m.top.authState.slug)
    if slug = "" then return
    m.mineSlug = slug
    path = "/api/shows?member=" + CreateObject("roUrlTransfer").Escape(slug) + "&include_archived=1"
    StartApi(m, { method: "GET", path: path, tag: "mine" }, "onMine")
end sub

sub onMine(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if res.json = invalid or res.json.shows = invalid then return
    m.mine = []
    for each s in res.json.shows
        m.mine.push(slimOwn(s))
    end for
    render()
end sub

' The own-library response carries every field of every row, cast JSON
' included. Keep only what matching, the card and the detail seed use — a
' library of a few hundred titles held in full is memory an older Roku does
' not have to spare.
function slimOwn(s as object) as object
    castNames = ""
    actors = s.actors
    if Type(actors) = "roString" or Type(actors) = "String" then actors = ParseJson(actors)
    if Type(actors) = "roArray"
        for each a in actors
            if a <> invalid and a.name <> invalid then castNames = castNames + "|" + LCase(SafeStr(a.name))
        end for
    end if
    return {
        kind:             "mine"
        id:               s.id
        title:            SafeStr(s.title)
        movie:            isTruthy(s.movie)
        list:             SafeStr(s.list)
        archived:         iifi(isTruthy(s.archived), 1, 0)
        poster_url:       SafeStr(s.poster_url)
        network_logo_url: SafeStr(s.network_logo_url)
        network:          SafeStr(s.network)
        tmdb_id:          SafeStr(s.tmdb_id)
        castLc:           castNames
    }
end function

' Two requests per query: TMDB for what can be added, and `?q=` on the
' group-copies endpoint for who already has it. The second is filtered
' server-side so the device holds only the matching copies, never the club
' library. Both callbacks drop a response for a query that is no longer the
' one on screen.
sub runSearch()
    q = currentQuery()
    if not loggedIn() or Len(q) < 2
        render()
        return
    end if
    m.activeQuery = q
    m.hits = []
    m.group = []
    m.searching = true
    m.searchFailed = false
    render()
    enc = CreateObject("roUrlTransfer").Escape(q)
    StartApi(m, { method: "GET", path: "/api/title-search?q=" + enc, tag: q }, "onHits")
    path = "/api/shows/all?q=" + enc + "&limit=" + Stri(ActiveProfile(m.top).maxResults).Trim()
    StartApi(m, { method: "GET", path: path, tag: q }, "onGroup")
end sub

sub onHits(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if SafeStr(res.tag) <> m.activeQuery then return
    m.searching = false
    m.hits = []
    if res.statusCode = 401
        showMessage("You're logged out — sign in again from the Account screen.")
        return
    end if
    if not res.ok or res.json = invalid or res.json.results = invalid
        m.searchFailed = true
    else
        m.searchFailed = false
        for each r in res.json.results
            m.hits.push(r)
        end for
    end if
    render()
    if m.focusOnResults
        m.focusOnResults = false
        if m.rowMeta.Count() > 0 then focusRows()
    end if
end sub

sub onGroup(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if SafeStr(res.tag) <> m.activeQuery then return
    m.group = []
    if not loggedIn() or res.json = invalid or res.json.shows = invalid then return
    me = SafeStr(m.top.authState.slug)
    for each s in res.json.shows
        if SafeStr(s.member_slug) <> me
            m.group.push({
                title:       LCase(SafeStr(s.title))
                movie:       isTruthy(s.movie)
                list:        SafeStr(s.list)
                member_slug: SafeStr(s.member_slug)
                member_name: SafeStr(s.member_name)
                tmdb_id:     SafeStr(s.tmdb_id)
            })
        end if
    end for
    ' The group line only shows in the caption, so refresh just that rather
    ' than rebuilding the rows under the viewer's focus.
    updateCaption()
end sub

' ---------- Render ----------

sub render()
    if not loggedIn()
        showMessage("Sign in from the Account screen to find shows and add them to your lists.")
        return
    end if
    q = currentQuery()
    if Len(q) < 2
        showMessage("Type a show or movie title to add it to your lists.")
        return
    end if

    myMatches = matchMine(q)
    root = CreateObject("roSGNode", "ContentNode")
    m.rowMeta = []
    profile = ActiveProfile(m.top)

    if myMatches.Count() > 0
        row = root.createChild("ContentNode")
        row.title = "On your lists"
        for each s in myMatches
            sub_ = ListTitle(s.list)
            badge = ""
            if s.archived = 1
                sub_ = "Archived"
                badge = "Archived"
            end if
            row.appendChild(MakeCardContent({
                title:          s.title + Chr(10) + sub_
                posterUrl:      TmdbWidth(s.poster_url, profile.posterWidth)
                networkLogoUrl: TmdbWidth(s.network_logo_url, profile.logoWidth)
                fallbackColor:  FallbackColor(s.title)
                badge:          badge
                payload:        s
            }))
        end for
        m.rowMeta.push("mine")
    end if

    ' A title you already have shows once, as your copy.
    newHits = []
    for each h in m.hits
        if not ownsHit(myMatches, h) then newHits.push(h)
    end for

    row = root.createChild("ContentNode")
    label = "Add a show"
    if m.searching and newHits.Count() = 0
        label = label + "  ·  Searching…"
    else if m.searchFailed
        label = label + "  ·  Couldn't reach the show catalog"
    else if newHits.Count() = 0 and myMatches.Count() = 0 and m.activeQuery = q
        label = label + "  ·  No shows found for “" + q + "”"
    end if
    row.title = label
    for each h in newHits
        yr = SafeStr(h.year)
        titleText = SafeStr(h.title)
        if yr <> "" then titleText = titleText + Chr(10) + "(" + yr + ")"
        payload = {
            kind:       "hit"
            title:      SafeStr(h.title)
            year:       yr
            tmdb_id:    h.tmdb_id
            media_type: SafeStr(h.media_type)
        }
        row.appendChild(MakeCardContent({
            title:         titleText
            posterUrl:     TmdbWidth(SafeStr(h.poster_url), profile.posterWidth)
            fallbackColor: FallbackColor(h.title)
            payload:       payload
        }))
    end for
    ' TMDB doesn't know everything, and it can be unreachable.
    row.appendChild(MakeCardContent({
        title:         "Add “" + q + "” as typed"
        posterUrl:     ""
        fallbackColor: Theme().surface
        payload:       { kind: "typed", title: q }
    }))
    m.rowMeta.push("hits")

    m.message.visible = false
    m.rows.visible = true
    m.rows.content = root
    updateCaption()
end sub

' Own copies whose title or cast contains the query, archived included.
function matchMine(q as string) as object
    ql = LCase(q)
    out = []
    for each s in m.mine
        if Instr(1, LCase(s.title), ql) > 0 or Instr(1, s.castLc, ql) > 0 then out.push(s)
    end for
    return out
end function

' Movie-ness is part of the match so owning Fargo the series doesn't hide
' Fargo the film, and a copy pinned to a TMDB entry matches only that entry,
' so owning one "The Odyssey" doesn't hide the other two.
function ownsHit(myMatches as object, h as object) as boolean
    for each s in myMatches
        if sameShow(LCase(s.title), s.movie, s.tmdb_id, h) then return true
    end for
    return false
end function

' title is lowercased by the caller; tmdbId is "" for a copy never pinned.
function sameShow(title as string, isMovie as boolean, tmdbId as string, h as object) as boolean
    if isMovie <> (SafeStr(h.media_type) = "movie") then return false
    if tmdbId <> "" then return tmdbId = SafeStr(h.tmdb_id)
    return title = LCase(SafeStr(h.title))
end function

' "Quinn · Watching, Amy · Loved" — group-mates with this title and where they
' keep it; two names, then a count.
function groupLine(h as object) as string
    seen = {}
    people = []
    for each c in m.group
        if sameShow(c.title, c.movie, c.tmdb_id, h) and seen[c.member_slug] = invalid
            seen[c.member_slug] = true
            name = c.member_name
            if name = "" then name = c.member_slug
            people.push(name + " · " + ListTitle(c.list))
        end if
    end for
    if people.Count() = 0 then return ""
    shown = people[0]
    if people.Count() > 1 then shown = shown + ", " + people[1]
    if people.Count() > 2 then shown = shown + " +" + Stri(people.Count() - 2).Trim()
    return shown
end function

sub onItemFocused()
    updateCaption()
end sub

sub updateCaption()
    item = focusedItem()
    if m.zone <> "rows" or item = invalid
        m.caption.visible = false
        return
    end if
    p = item.payload
    text = ""
    if p.kind = "mine"
        if p.archived = 1
            text = p.title + " — archived; open it to restore"
        else
            text = p.title + " — on your " + ListTitle(p.list) + " list"
        end if
    else if p.kind = "hit"
        kindText = "TV"
        if p.media_type = "movie" then kindText = "Movie"
        text = p.title
        if p.year <> "" then text = text + " (" + p.year + ")"
        text = text + " · " + kindText
        who = groupLine(p)
        if who <> "" then text = text + Chr(10) + who
    else
        text = "Adds “" + p.title + "” exactly as typed, for a title the catalog doesn't have."
    end if
    m.caption.text = text
    m.caption.visible = true
end sub

function focusedItem() as object
    f = m.rows.rowItemFocused
    if f = invalid or m.rows.content = invalid then return invalid
    row = m.rows.content.getChild(f[0])
    if row = invalid then return invalid
    return row.getChild(f[1])
end function

sub showMessage(text as string)
    m.message.text = text
    m.message.visible = true
    m.rows.visible = false
    m.rows.content = CreateObject("roSGNode", "ContentNode")
    m.rowMeta = []
    m.caption.visible = false
    if m.zone = "rows" then focusKeyboard()
end sub

' ---------- Adding ----------

sub onItemSelected()
    sel = m.rows.rowItemSelected
    if sel = invalid then return
    row = m.rows.content.getChild(sel[0])
    if row = invalid then return
    item = row.getChild(sel[1])
    if item = invalid then return
    p = item.payload
    if p.kind = "mine"
        m.top.navigate = { action: "openDetail", data: { id: p.id, seed: p } }
        return
    end if
    m.pending = p
    promptForList()
end sub

' Which list gets the show.
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

    ' A TMDB pick is pinned to its id; a typed title goes in bare, as a show.
    r = m.pending
    mediaType = SafeStr(r.media_type)
    body = {
        title: SafeStr(r.title)
        list: listKey
        movie: iifi(mediaType = "movie", 1, 0)
        full_series: 0
    }
    if r.kind = "hit"
        if r.tmdb_id <> invalid then body.tmdb_id = r.tmdb_id
        if mediaType <> "" then body.tmdb_type = mediaType
    end if

    m.addedList = listKey
    SetBusy(m, true)
    StartApi(m, { method: "POST", path: "/api/shows", body: FormatJson(body), tag: "add" }, "onAdded")
end sub

function iifi(cond as boolean, a as integer, b as integer) as integer
    if cond then return a
    return b
end function

' Numbers, booleans and strings all come back from D1 for a 0/1 column
' depending on the path; treat them alike.
function isTruthy(v as dynamic) as boolean
    if v = invalid then return false
    t = Type(v)
    if t = "Boolean" or t = "roBoolean" then return v
    if t = "roString" or t = "String" then return (v = "1" or LCase(v) = "true")
    return (SafeStr(v) = "1")
end function

sub onAdded(ev as object)
    FinishApi(m, ev)
    SetBusy(m, false)
    res = ev.getRoSGNode().result
    titleText = SafeStr(m.pending.title)
    dialog = CreateObject("roSGNode", "Dialog")
    if res.ok
        dialog.title = "Added"
        dialog.message = "“" + titleText + "” added to " + ListTitle(m.addedList) + "."
        ' It now belongs under "On your lists" rather than the results.
        loadMine()
    else if res.statusCode = 409
        dialog.title = "Already added"
        dialog.message = "“" + titleText + "” is already on one of your lists (maybe archived)."
    else if res.statusCode = 401
        dialog.title = "Signed out"
        dialog.message = "You're logged out — sign in again from the Account screen."
    else
        dialog.title = "Couldn't add"
        dialog.message = "Please try again."
    end if
    dialog.buttons = ["OK"]
    ' A Dialog does not dismiss itself. Without an observer, OK is a button
    ' that visibly does nothing.
    dialog.observeField("buttonSelected", "onDialogDismissed")
    dialog.observeField("wasClosed", "onDialogDismissed")
    m.top.getScene().dialog = dialog
end sub

sub onDialogDismissed()
    m.top.getScene().dialog = invalid
    if m.rowMeta.Count() > 0
        focusRows()
    else
        focusKeyboard()
    end if
end sub

' ---------- Focus: keyboard <-> buttons <-> results ----------
'
' Leaving the Keyboard depends on the Keyboard *declining* the key so it bubbles
' up to here, and Roku firmware differs on whether the bottom row passes Down
' along. Right and the ✱/options key are the backups. Down is confirmed
' working on a Streaming Stick 4K (OS 15.3); the others stay for the older
' hardware this channel targets, where the firmware may differ.
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    hasResults = (m.rowMeta.Count() > 0)

    if m.zone = "kb"
        if key = "down" or key = "options"
            focusButtons()
            return true
        else if key = "right" and hasResults
            focusRows()
            return true
        end if
    else if m.zone = "buttons"
        if key = "up" or key = "options"
            focusKeyboard()
            return true
        else if key = "right" and hasResults
            focusRows()
            return true
        else if key = "down"
            ' Swallow it. This group is horizontal, so Down has no business
            ' moving between buttons — and the button it moved onto was Clear,
            ' which throws away what was just typed. Left/Right navigate.
            return true
        end if
    else if m.zone = "rows"
        ' Left only reaches here from the first card of a row.
        if key = "left" or key = "options"
            focusKeyboard()
            return true
        end if
    end if
    return false
end function

' MainScene focuses the screen itself when it is pushed or returned to, which
' leaves the keyboard (or whatever the viewer was on) without focus. Hand it
' back to the current zone.
sub onFocusedChild()
    if not m.top.hasFocus() then return
    if m.zone = "rows" and m.rowMeta.Count() > 0
        focusRows()
    else if m.zone = "buttons"
        focusButtons()
    else
        focusKeyboard()
    end if
end sub

sub focusKeyboard()
    m.zone = "kb"
    m.kb.setFocus(true)
    m.caption.visible = false
end sub

sub focusButtons()
    m.zone = "buttons"
    ' Land on the search action rather than wherever the group was last left —
    ' leaving the keyboard means "I've typed it", and Clear is a trap there.
    ' focusButton has to be set *after* setFocus: assigning it to a group that
    ' does not yet hold focus is overridden when focus arrives.
    m.buttons.setFocus(true)
    m.buttons.focusButton = 1
    m.caption.visible = false
end sub

sub focusRows()
    m.zone = "rows"
    m.rows.setFocus(true)
    updateCaption()
end sub
