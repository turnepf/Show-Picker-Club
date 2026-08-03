' Helpers that turn API JSON into ContentNodes for RowLists / grids.

' Build a PosterCard ContentNode. `payload` (assocarray) carries the raw
' record so selection handlers can act on it (open detail, add, etc.).
function MakeCardContent(fields as object) as object
    n = CreateObject("roSGNode", "ContentNode")
    n.addFields({
        title:          SafeStr(fields.title)
        posterUrl:      SafeStr(fields.posterUrl)
        networkLogoUrl: SafeStr(fields.networkLogoUrl)
        fallbackColor:  SafeStr(fields.fallbackColor)
        badge:          SafeStr(fields.badge)
    })
    if fields.payload <> invalid
        n.addField("payload", "assocarray", false)
        n.payload = fields.payload
    end if
    return n
end function

' A "next up" premiere date -> short "M/D" badge, matching tvOS nextUpRange.
function PremiereBadge(show as object) as string
    d = SafeStr(show.next_season_date)
    if d = "" then return ""
    ' Expect ISO yyyy-mm-dd; render as M/D.
    parts = d.Split("-")
    if parts.Count() < 3 then return ""
    mo = parts[1].ToInt()
    dy = parts[2].Split("T")[0].ToInt()
    if mo = 0 or dy = 0 then return ""
    return Stri(mo).Trim() + "/" + Stri(dy).Trim()
end function

' Turn a /api/shows show object into a PosterCard ContentNode.
function ShowCardNode(show as object) as object
    return MakeCardContent({
        title:          SafeStr(show.title)
        posterUrl:      SafeStr(show.poster_url)
        networkLogoUrl: SafeStr(show.network_logo_url)
        fallbackColor:  FallbackColor(show.title)
        badge:          PremiereBadge(show)
        payload:        show
    })
end function

' Member tile ContentNode (rendered by PosterCard fallback styling).
function MemberCardNode(member as object) as object
    label = SafeStr(member.display_name)
    if label = "" then label = SafeStr(member.name)
    watching = 0
    if member.watching_count <> invalid then watching = member.watching_count
    sub_ = Stri(watching).Trim() + " watching"
    return MakeCardContent({
        title:         label + Chr(10) + sub_
        posterUrl:     ""
        fallbackColor: FallbackColor(label)
        payload:       member
    })
end function
