sub init()
    m.bg = m.top.findNode("bg")
    m.poster = m.top.findNode("poster")
    m.title = m.top.findNode("title")
    m.titleScrim = m.top.findNode("titleScrim")
    m.badge = m.top.findNode("badge")
    m.netlogo = m.top.findNode("netlogo")
    m.fallbackTitle = m.top.findNode("fallbackTitle")
    m.top.scaleRotateCenter = [140, 210]
end sub

sub onContentSet()
    c = m.top.itemContent
    if c = invalid then return

    titleText = SafeStr(c.title)
    m.title.text = titleText

    posterUrl = SafeStr(c.posterUrl)
    if posterUrl <> ""
        m.poster.uri = posterUrl
        m.poster.visible = true
        m.bg.color = "0x1C1F26FF"
        m.fallbackTitle.visible = false
    else
        m.poster.uri = ""
        m.poster.visible = false
        m.bg.color = SafeStr(c.fallbackColor)
        m.fallbackTitle.text = titleText
        m.fallbackTitle.visible = true
    end if

    logo = SafeStr(c.networkLogoUrl)
    if logo <> ""
        m.netlogo.uri = logo
        m.netlogo.visible = true
    else
        m.netlogo.visible = false
    end if

    badgeText = SafeStr(c.badge)
    if badgeText <> ""
        m.badge.text = badgeText
        m.badge.visible = true
    else
        m.badge.visible = false
    end if
end sub

sub onFocusChange()
    p = m.top.focusPercent
    s = 1.0 + 0.06 * p
    m.top.scale = [s, s]
    showTitle = (p > 0.5)
    ' Keep the title always visible when there is no artwork.
    if m.fallbackTitle.visible then showTitle = false
    m.title.visible = showTitle
    m.titleScrim.visible = showTitle
end sub
