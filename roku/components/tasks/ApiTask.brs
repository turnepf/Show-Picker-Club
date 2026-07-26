' Generic HTTP worker. All networking happens here on the Task thread.
' Reads/writes the session cookie (registry) and replays it as a Cookie header.

sub init()
    m.top.functionName = "run"
end sub

sub run()
    req = m.top.request
    cfg = Config()

    method = "GET"
    if req.method <> invalid then method = UCase(req.method)
    path = SafeStr(req.path)
    body = SafeStr(req.body)
    tag = SafeStr(req.tag)

    xfer = CreateObject("roUrlTransfer")
    port = CreateObject("roMessagePort")
    xfer.SetMessagePort(port)
    xfer.SetCertificatesFile("common:/certs/ca-bundle.crt")
    xfer.InitClientCertificates()
    xfer.EnableEncodings(true)
    xfer.RetainBodyOnError(true)
    xfer.SetUrl(cfg.baseUrl + path)
    xfer.AddHeader("X-Client-Platform", cfg.platform)
    xfer.AddHeader("Accept", "application/json")

    ' Replay the stored session cookie. Deliberately NO Origin header, so the
    ' backend treats us as a native client and never issues a Turnstile challenge.
    cookie = GetSessionCookie()
    if cookie <> "" then xfer.AddHeader("Cookie", "session=" + cookie)

    started = false
    if method = "GET"
        started = xfer.AsyncGetToString()
    else
        xfer.AddHeader("Content-Type", "application/json")
        if method <> "POST" then xfer.SetRequest(method)  ' PUT etc.
        started = xfer.AsyncPostFromString(body)
    end if

    result = { statusCode: -1, ok: false, body: "", json: invalid, tag: tag }

    if started
        ev = wait(30000, port)
        if type(ev) = "roUrlEvent"
            result.statusCode = ev.GetResponseCode()
            result.body = ev.GetString()
            result.ok = (result.statusCode >= 200 and result.statusCode < 300)

            ' Persist any session cookie the server hands back on login.
            headers = ev.GetResponseHeadersArray()
            if headers <> invalid
                for each h in headers
                    for each k in h
                        if LCase(k) = "set-cookie"
                            token = ExtractSessionFromSetCookie(h[k])
                            if token <> "" then SaveSessionCookie(token)
                        end if
                    end for
                end for
            end if

            if result.body <> ""
                parsed = ParseJson(result.body)
                if parsed <> invalid then result.json = parsed
            end if
        else
            xfer.AsyncCancel()
        end if
    end if

    m.top.result = result
end sub
