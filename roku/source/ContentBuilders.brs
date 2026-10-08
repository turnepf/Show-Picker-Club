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

' Today as yyyy-mm-dd on the device's clock. Stored dates are air dates, so
' they compare against it as strings.
function TodayYmd() as string
    dt = CreateObject("roDateTime")
    dt.ToLocalTime()
    mo = dt.GetMonth()
    dy = dt.GetDayOfMonth()
    m = Stri(mo).Trim()
    if mo < 10 then m = "0" + m
    d = Stri(dy).Trim()
    if dy < 10 then d = "0" + d
    return Stri(dt.GetYear()).Trim() + "-" + m + "-" + d
end function

' A "next up" date -> short "M/D" badge, matching tvOS nextUpRange: the next
' episode while it's still ahead, else the premiere of a season about to
' start (current_season, migration 087). A date that has passed is never
' shown: it means the refresh hasn't caught up since the episode aired.
function PremiereBadge(show as object) as string
    today = TodayYmd()
    d = Left(SafeStr(show.next_season_date), 10)
    if d = "" or d < today
        d = Left(SafeStr(show.season_premiere_date), 10)
        if d = "" or d <= today then return ""
    end if
    ' Expect ISO yyyy-mm-dd; render as M/D.
    parts = d.Split("-")
    if parts.Count() < 3 then return ""
    mo = parts[1].ToInt()
    dy = parts[2].Split("T")[0].ToInt()
    if mo = 0 or dy = 0 then return ""
    return Stri(mo).Trim() + "/" + Stri(dy).Trim()
end function

' Turn a /api/shows show object into a PosterCard ContentNode.
'
' `profile` comes from Profile(m.top) — read it once per screen and pass it in;
' a row can hold hundreds of these and re-deriving the device tier per card
' would cost more than the sizing saves.
function ShowCardNode(show as object, profile as object) as object
    return MakeCardContent({
        title:          SafeStr(show.title)
        posterUrl:      TmdbWidth(SafeStr(show.poster_url), profile.posterWidth)
        networkLogoUrl: TmdbWidth(SafeStr(show.network_logo_url), profile.logoWidth)
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
