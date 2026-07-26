sub init()
    m.nav = m.top.findNode("nav")
    m.rows = m.top.findNode("rows")
    m.empty = m.top.findNode("empty")

    m.trending = []
    m.members = []
    m.focusZone = "nav"

    m.rows.showRowLabel = [true, true]
    m.nav.observeField("buttonSelected", "onNavButton")
    m.rows.observeField("rowItemSelected", "onRowSelected")

    buildNavButtons()
    loadTrending()
    m.nav.setFocus(true)
end sub

sub onAuth()
    buildNavButtons()
    ' Members shelf is logged-in only.
    if m.top.authState <> invalid and m.top.authState.loggedIn = true
        loadMembers()
    else
        m.members = []
        rebuildRows()
    end if
end sub

sub onReturn()
    ' Refresh counts when returning to Home.
    if m.top.authState <> invalid and m.top.authState.loggedIn = true then loadMembers()
end sub

sub buildNavButtons()
    loggedIn = (m.top.authState <> invalid and m.top.authState.loggedIn = true)
    buttons = []
    m.navActions = []
    if loggedIn
        buttons.push("My Shows") : m.navActions.push("myshows")
        buttons.push("Search")   : m.navActions.push("search")
        buttons.push("Add Show") : m.navActions.push("add")
        buttons.push("Account")  : m.navActions.push("account")
    else
        buttons.push("Search")  : m.navActions.push("search")
        buttons.push("Sign In") : m.navActions.push("account")
    end if
    m.nav.buttons = buttons
end sub

sub onNavButton()
    idx = m.nav.buttonSelected
    if idx < 0 or idx >= m.navActions.Count() then return
    action = m.navActions[idx]
    if action = "search"
        m.top.navigate = { action: "openSearch" }
    else if action = "add"
        m.top.navigate = { action: "openAdd" }
    else if action = "account"
        m.top.navigate = { action: "openAccount" }
    else if action = "myshows"
        me = { slug: m.top.authState.slug, display_name: "My Shows", name: "My Shows" }
        m.top.navigate = { action: "openMember", data: me }
    end if
end sub

' ---------- Data ----------
sub loadTrending()
    m.empty.visible = true
    StartApi(m, { method: "GET", path: "/api/popular", tag: "popular" }, "onTrending")
end sub

sub onTrending(ev as object)
    res = ev.getRoSGNode().result
    m.trending = []
    if res.json <> invalid and res.json.shows <> invalid
        for each s in res.json.shows
            m.trending.push(s)
        end for
    end if
    rebuildRows()
end sub

sub loadMembers()
    StartApi(m, { method: "GET", path: "/api/members", tag: "members" }, "onMembers")
end sub

sub onMembers(ev as object)
    res = ev.getRoSGNode().result
    m.members = []
    if res.json <> invalid and res.json.members <> invalid
        for each mem in res.json.members
            m.members.push(mem)
        end for
    end if
    rebuildRows()
end sub

sub rebuildRows()
    root = CreateObject("roSGNode", "ContentNode")
    m.rowMeta = []  ' parallel: "trending" / "members"

    if m.trending.Count() > 0
        row = root.createChild("ContentNode")
        row.title = "Trending"
        for each s in m.trending
            row.appendChild(ShowCardNode(s))
        end for
        m.rowMeta.push("trending")
    end if

    if m.members.Count() > 0
        row = root.createChild("ContentNode")
        row.title = "Members"
        for each mem in m.members
            row.appendChild(MemberCardNode(mem))
        end for
        m.rowMeta.push("members")
    end if

    m.rows.content = root
    m.empty.visible = (m.rowMeta.Count() = 0)
    if m.rowMeta.Count() = 0 then m.empty.text = "Nothing to show yet."
end sub

sub onRowSelected()
    sel = m.rows.rowItemSelected
    if sel = invalid then return
    rowIdx = sel[0]
    colIdx = sel[1]
    if rowIdx >= m.rowMeta.Count() then return
    kind = m.rowMeta[rowIdx]
    item = m.rows.content.getChild(rowIdx).getChild(colIdx)
    if item = invalid then return
    payload = item.payload

    if kind = "trending"
        m.top.navigate = { action: "openDetail", data: { id: payload.id } }
    else if kind = "members"
        m.top.navigate = { action: "openMember", data: payload }
    end if
end sub

' ---------- Focus flow between the nav bar and the rows ----------
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "down" and m.focusZone = "nav"
        if m.rowMeta <> invalid and m.rowMeta.Count() > 0
            m.focusZone = "rows"
            m.rows.setFocus(true)
            return true
        end if
    else if key = "up" and m.focusZone = "rows"
        if m.rows.rowItemFocused <> invalid and m.rows.rowItemFocused[0] = 0
            m.focusZone = "nav"
            m.nav.setFocus(true)
            return true
        end if
    end if
    return false
end function
