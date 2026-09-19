sub init()
    m.bg = m.top.findNode("bg")
    m.poster = m.top.findNode("poster")
    m.title = m.top.findNode("title")
    m.titleScrim = m.top.findNode("titleScrim")
    m.badge = m.top.findNode("badge")
    m.netlogo = m.top.findNode("netlogo")
    m.fallbackTitle = m.top.findNode("fallbackTitle")
    m.top.scaleRotateCenter = [140, 210]
    ' Re-scaling a bitmap every frame is the expensive operation on the legacy
    ' graphics stack, and a row of these animates together. The card still
    ' reveals its title on focus — only the zoom goes away.
    m.focusScale = ActiveProfile(m.top).focusScale
end sub

' Everything a card can draw without a network round trip is set first, and
' the image URIs go on last. Assigning a `uri` hands the fetch and decode to
' the image loader, so a card that is text-complete before that point shows
' its title, colour and badge immediately and fills the artwork in behind —
' rather than appearing blank until the poster lands.
sub onContentSet()
    c = m.top.itemContent
    if c = invalid then return

    titleText = SafeStr(c.title)
    m.title.text = titleText

    posterUrl = SafeStr(c.posterUrl)
    hasPoster = (posterUrl <> "")
    if hasPoster
        m.bg.color = "0x1C1F26FF"
        m.fallbackTitle.visible = false
    else
        m.bg.color = SafeStr(c.fallbackColor)
        m.fallbackTitle.text = titleText
        m.fallbackTitle.visible = true
    end if
    m.poster.visible = hasPoster

    badgeText = SafeStr(c.badge)
    if badgeText <> ""
        m.badge.text = badgeText
        m.badge.visible = true
    else
        m.badge.visible = false
    end if

    logo = SafeStr(c.networkLogoUrl)
    m.netlogo.visible = (logo <> "")

    ' --- text and layout are done; start the image work ---
    if hasPoster then m.poster.uri = posterUrl else m.poster.uri = ""
    if logo <> "" then m.netlogo.uri = logo
end sub

sub onFocusChange()
    p = m.top.focusPercent
    if m.focusScale
        s = 1.0 + 0.06 * p
        m.top.scale = [s, s]
    end if
    showTitle = (p > 0.5)
    ' Keep the title always visible when there is no artwork.
    if m.fallbackTitle.visible then showTitle = false
    m.title.visible = showTitle
    m.titleScrim.visible = showTitle
end sub
