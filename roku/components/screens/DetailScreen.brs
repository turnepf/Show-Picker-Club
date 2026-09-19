sub init()
    m.hero = m.top.findNode("hero")
    m.heroFallback = m.top.findNode("heroFallback")
    m.title = m.top.findNode("title")
    m.meta = m.top.findNode("meta")
    m.chip = m.top.findNode("chip")
    m.genres = m.top.findNode("genres")
    m.overview = m.top.findNode("overview")
    m.cast = m.top.findNode("cast")
    m.ratings = m.top.findNode("ratings")
    m.actions = m.top.findNode("actions")
    m.status = m.top.findNode("status")
    m.busy = m.top.findNode("busy")
    m.actions.observeField("buttonSelected", "onAction")
end sub

' Draw what the card already told us — title and its artwork — before the
' detail request comes back. The poster URI is sized with posterWidth, not
' heroWidth, on purpose: that is the exact URL the card just loaded, so it is
' already in the image cache and paints in the same frame instead of costing a
' second download. render() replaces it with the full-size hero afterwards.
sub onSeedSet()
    seed = m.top.seed
    if seed = invalid then return
    m.title.text = SafeStr(seed.title)

    poster = TmdbWidth(SafeStr(seed.poster_url), Profile(m.top).posterWidth)
    if poster <> ""
        m.hero.width = 300 : m.hero.height = 450
        m.hero.uri = poster
        m.heroFallback.visible = false
    else
        m.heroFallback.color = FallbackColor(seed.title)
        m.heroFallback.visible = true
    end if
end sub

sub onIdSet()
    id = m.top.showId
    if id = 0 then return
    setBusySpinner(true)
    StartApi(m, { method: "GET", path: "/api/shows/" + Stri(id).Trim(), tag: "detail" }, "onDetail")
    StartApi(m, { method: "GET", path: "/api/shows/" + Stri(id).Trim() + "/actors", tag: "actors" }, "onActors")
end sub

' Auth can resolve after the detail GET already rendered (checkAuth runs in
' parallel with showing Home) — re-render so mine/logged-in actions catch up.
sub onAuthChanged()
    if m.show <> invalid then render()
end sub

sub onDetail(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    setBusySpinner(false)
    if res.json = invalid or res.json.show = invalid
        m.title.text = "Not found"
        return
    end if
    m.show = res.json.show
    m.ratingsData = res.json.ratings
    render()
end sub

sub onActors(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if res.json = invalid or res.json.actors = invalid then return
    names = []
    for each a in res.json.actors
        if names.Count() >= 10 then exit for
        names.push(SafeStr(a.name))
    end for
    if names.Count() > 0
        line = "Cast: " + names[0]
        for i = 1 to names.Count() - 1
            line = line + ", " + names[i]
        end for
        m.cast.text = line
    end if
end sub

sub render()
    s = m.show

    ' A 720x405 backdrop is the nicest version of this screen and the most
    ' expensive single bitmap in the channel. Legacy devices get the poster
    ' instead — smaller, and usually already cached from the card that was
    ' just on screen — rather than a backdrop that competes with the row of
    ' posters still held behind this view.
    profile = Profile(m.top)
    backdrop = SafeStr(s.backdrop_url)
    poster = SafeStr(s.poster_url)
    if backdrop <> "" and profile.useBackdrop
        m.hero.width = 720 : m.hero.height = 405
        m.hero.uri = TmdbWidth(backdrop, profile.heroWidth)
        m.heroFallback.visible = false
    else if poster <> ""
        m.hero.width = 300 : m.hero.height = 450
        m.hero.uri = TmdbWidth(poster, profile.heroWidth)
        m.heroFallback.visible = false
    else
        m.hero.uri = ""
        m.heroFallback.color = FallbackColor(s.title)
        m.heroFallback.visible = true
    end if

    m.title.text = SafeStr(s.title)

    metaBits = []
    if SafeStr(s.release_year) <> "" then metaBits.push(SafeStr(s.release_year))
    if s.runtime <> invalid and s.runtime > 0 then metaBits.push(Stri(s.runtime).Trim() + " min")
    if SafeStr(s.content_rating) <> "" then metaBits.push(SafeStr(s.content_rating))
    if SafeStr(s.rating) <> "" then metaBits.push("★ " + SafeStr(s.rating))
    m.meta.text = joinList(metaBits, "  ·  ")

    ' List / archived chip.
    if ownedByMe()
        if s.archived <> invalid and s.archived = 1
            m.chip.text = "Archived"
        else
            m.chip.text = "On " + ListTitle(SafeStr(s.list))
        end if
        m.chip.color = ListColor(SafeStr(s.list))
    else
        m.chip.text = SafeStr(s.network)
        m.chip.color = "0xFFFFFF99"
    end if

    m.genres.text = SafeStr(s.genres)
    m.overview.text = SafeStr(s.overview)
    m.ratings.text = ratingsLine()

    buildActions()
    m.actions.setFocus(true)
end sub

function joinList(arr as object, sep as string) as string
    if arr.Count() = 0 then return ""
    out = arr[0]
    for i = 1 to arr.Count() - 1
        out = out + sep + arr[i]
    end for
    return out
end function

function ratingsLine() as string
    r = m.ratingsData
    if r = invalid then return ""
    parts = []
    if r.average <> invalid
        cnt = 0
        if r.count <> invalid then cnt = r.count
        parts.push("Club rating " + SafeStr(r.average) + " (" + Stri(cnt).Trim() + ")")
    end if
    if r.owner <> invalid and r.ownerName <> invalid
        parts.push(SafeStr(r.ownerName) + ": " + SafeStr(r.owner))
    end if
    return joinList(parts, "    ·    ")
end function

function loggedIn() as boolean
    return (m.top.authState <> invalid and m.top.authState.loggedIn = true)
end function

function ownedByMe() as boolean
    if not loggedIn() then return false
    if m.show = invalid then return false
    return SafeStr(m.show.member_slug) = SafeStr(m.top.authState.slug)
end function

' Build the action buttons and remember what each one does.
sub buildActions()
    labels = ["< Back"]
    m.actionKind = ["back"]   ' "back" | "move:<key>" | "add:<key>" | "archive" | "restore" | "watch"

    mine = ownedByMe()
    archived = (m.show.archived <> invalid and m.show.archived = 1)

    if loggedIn()
        for each l in ShowLists()
            prefix = ""
            if mine and not archived and SafeStr(m.show.list) = l.key then prefix = "✓ "
            labels.push(prefix + l.title)
            if mine and not archived
                m.actionKind.push("move:" + l.key)
            else
                m.actionKind.push("add:" + l.key)
            end if
        end for
        if mine
            if archived
                labels.push("Restore") : m.actionKind.push("restore")
            else
                labels.push("Archive") : m.actionKind.push("archive")
            end if
        end if
    end if

    labels.push("Where to Watch") : m.actionKind.push("watch")
    m.actions.buttons = labels
end sub

sub onAction()
    idx = m.actions.buttonSelected
    if idx < 0 or idx >= m.actionKind.Count() then return
    kind = m.actionKind[idx]

    if kind = "back"
        m.top.navigate = { action: "back" }
        return
    end if
    if kind = "watch"
        showWatchInfo()
        return
    end if
    if not loggedIn()
        setStatus("Sign in from the Account screen first.")
        return
    end if

    id = Stri(m.top.showId).Trim()
    if Left(kind, 5) = "move:"
        listKey = Mid(kind, 6)
        StartApi(m, { method: "PUT", path: "/api/shows/" + id + "/move", body: FormatJson({ list: listKey }), tag: "move:" + listKey }, "onWriteDone")
    else if Left(kind, 4) = "add:"
        listKey = Mid(kind, 5)
        addToMyList(listKey)
    else if kind = "archive"
        StartApi(m, { method: "PUT", path: "/api/shows/" + id, body: FormatJson({ archived: 1 }), tag: "archive" }, "onWriteDone")
    else if kind = "restore"
        target = SafeStr(m.show.list)
        if target = "" then target = "watching"
        StartApi(m, { method: "PUT", path: "/api/shows/" + id, body: FormatJson({ archived: 0, list: target }), tag: "restore:" + target }, "onWriteDone")
    end if
end sub

sub addToMyList(listKey as string)
    s = m.show
    body = {
        title: SafeStr(s.title)
        list: listKey
        movie: intOf(s.movie)
        full_series: intOf(s.full_series)
    }
    if SafeStr(s.network) <> "" then body.network = SafeStr(s.network)
    if SafeStr(s.network_url) <> "" then body.network_url = SafeStr(s.network_url)
    if s.tmdb_id <> invalid then body.tmdb_id = s.tmdb_id
    if SafeStr(s.tmdb_type) <> "" then body.tmdb_type = SafeStr(s.tmdb_type)
    StartApi(m, { method: "POST", path: "/api/shows", body: FormatJson(body), tag: "add:" + listKey }, "onWriteDone")
end sub

function intOf(v as dynamic) as integer
    if v = invalid then return 0
    t = Type(v)
    if t = "Boolean" or t = "roBoolean"
        if v then return 1
        return 0
    end if
    if t = "Integer" or t = "roInt" or t = "roInteger" or t = "LongInteger" or t = "roLongInteger"
        if v = 1 then return 1
        return 0
    end if
    return 0
end function

sub onWriteDone(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    tag = SafeStr(res.tag)
    if res.statusCode = 401
        setStatus("You're logged out — sign in again from the Account screen.")
        return
    end if
    if not res.ok
        setStatus("Something went wrong. Please try again.")
        return
    end if

    if Left(tag, 5) = "move:"
        m.show.list = Mid(tag, 6)
        setStatus("Moved to " + ListTitle(m.show.list))
    else if Left(tag, 4) = "add:"
        setStatus("Added to " + ListTitle(Mid(tag, 5)))
    else if tag = "archive"
        m.show.archived = 1
        setStatus("Archived")
    else if Left(tag, 8) = "restore:"
        m.show.archived = 0
        m.show.list = Mid(tag, 9)
        setStatus("Restored to " + ListTitle(m.show.list))
    end if
    render()
end sub

sub setStatus(msg as string)
    m.status.text = msg
    m.status.visible = true
end sub

sub showWatchInfo()
    s = m.show
    net = SafeStr(s.network)
    dialog = CreateObject("roSGNode", "Dialog")
    dialog.title = "Where to Watch"
    lines = []
    if net <> "" then lines.push(net)
    if IsRealUrl(s.network_url)
        lines.push(SafeStr(s.network_url))
    else if IsRealUrl(s.watch_link)
        lines.push(SafeStr(s.watch_link))
    end if
    if lines.Count() = 0 then lines.push("No streaming info available yet.")
    dialog.message = joinList(lines, Chr(10))
    dialog.buttons = ["OK"]
    m.top.getScene().dialog = dialog
end sub

' The spinner only animates while its `control` is "start" — toggling
' visibility alone leaves a frozen image on screen.
sub setBusySpinner(on as boolean)
    m.busy.visible = on
    if on
        m.busy.control = "start"
    else
        m.busy.control = "stop"
    end if
end sub
