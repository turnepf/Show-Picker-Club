sub init()
    m.heading = m.top.findNode("heading")
    m.prompt = m.top.findNode("prompt")
    m.kb = m.top.findNode("kb")
    m.actions = m.top.findNode("actions")
    m.status = m.top.findNode("status")
    m.actions.observeField("buttonSelected", "onAction")
    m.kb.observeField("text", "onKeyboardText")
    m.rokuAccount = m.top.findNode("rokuAccount")
    m.rokuAccount.observeField("userData", "onRokuAccountData")
    m.askedRokuAccount = false

    m.step = "init"
    m.lastSubmittedCode = ""
    m.channel = "email"
    m.identifier = ""
    m.zone = "actions"
end sub

sub onAuth()
    if m.step = "init" then renderRoot()
end sub

sub renderRoot()
    clearStatus()
    if loggedIn()
        m.step = "account"
        m.heading.text = "Account"
        info = SafeStr(m.top.authState.email)
        if m.top.authState.isAdmin = true then info = info + "    (Operator)"
        m.prompt.text = info
        m.kb.visible = false
        m.actions.translation = [90, 260]
        m.status.translation = [90, 500]
        m.actionKeys = ["signout", "delete", "back"]
        m.actions.buttons = ["Sign Out", "Delete Account", "< Back"]
        m.actions.visible = true
        focusActions()
    else
        m.step = "choose"
        m.heading.text = "Sign In"
        m.prompt.text = "Choose how you'd like to receive your one-time code."
        ' Offer the member's Roku account before asking them to type anything.
        ' Certification requires the attempt; the manual choices below are the
        ' fallback for when they decline, which is explicitly allowed.
        askRokuAccount()
        m.kb.visible = false
        m.actions.translation = [90, 260]
        m.status.translation = [90, 500]
        m.actionKeys = ["email", "phone", "back"]
        m.actions.buttons = ["Continue with Email", "Continue with Phone", "< Back"]
        m.actions.visible = true
        focusActions()
    end if
end sub

function loggedIn() as boolean
    return (m.top.authState <> invalid and m.top.authState.loggedIn = true)
end function

sub onAction()
    idx = m.actions.buttonSelected
    if idx < 0 or idx >= m.actionKeys.Count() then return
    key = m.actionKeys[idx]

    if key = "back"
        m.top.navigate = { action: "back" }
    else if key = "email" or key = "phone"
        m.channel = key
        startIdentifier()
    else if key = "signout"
        StartApi(m, { method: "GET", path: "/auth/logout", tag: "logout" }, "onLogout")
    else if key = "delete"
        m.mode = "delete"
        StartApi(m, { method: "POST", path: "/api/account-delete", body: "{}", tag: "delete-init" }, "onDeleteInit")
    else if key = "submit"
        onSubmit()
    end if
end sub

' ---- Roku account (Request for Information) ----
'
' Asks Roku to show its own consent screen offering the email and phone on the
' member's Roku account. Certification RP 2.1 / 4.1 require an authenticated
' app to do this rather than going straight to a keyboard. It is an offer, not
' a sign-in: whatever comes back still has to pass the same one-time code as a
' hand-typed address, so this shortens the typing and changes nothing about
' who gets a session.
sub askRokuAccount()
    if m.askedRokuAccount then return
    m.askedRokuAccount = true
    m.rokuAccount.requestedUserData = "email,phone"
    m.rokuAccount.command = "getUserData"
end sub

' Declining is normal and is not an error — the manual choices are already on
' screen, so there is nothing to do but let the member use them.
sub onRokuAccountData()
    data = m.rokuAccount.userData
    if data = invalid then return

    email = ""
    phone = ""
    if data.email <> invalid then email = SafeStr(data.email).Trim()
    if data.phone <> invalid then phone = SafeStr(data.phone).Trim()

    if email <> ""
        m.channel = "email"
        m.identifier = email
    else if phone <> ""
        m.channel = "phone"
        m.identifier = phone
    else
        return
    end if

    ' They have consented and we have an identifier — send the code straight
    ' away rather than showing it back to them on a keyboard they did not ask
    ' for.
    m.step = "code-pending"
    m.prompt.text = "Sending a code to " + m.identifier + "…"
    m.kb.visible = false
    m.actions.visible = false
    sendCodeTo(m.identifier)
end sub

' ---- Login flow ----
sub startIdentifier()
    m.step = "identifier"
    if m.channel = "email"
        m.prompt.text = "Enter your email address."
    else
        m.prompt.text = "Enter your phone number."
    end if
    setSubmitButton("Send Code")
    if m.channel = "email"
        showKeyboard("", "email")
    else
        showKeyboard("", "text")
    end if
end sub

' Post the request for a given identifier, whether it was typed on the
' keyboard or came back from the Roku account consent screen. One definition
' so the two entry points cannot drift apart on the payload shape.
sub sendCodeTo(identifier as string)
    if identifier = "" then return
    m.identifier = identifier
    if m.channel = "email"
        body = { email: identifier, channel: "email" }
    else
        body = { phone: identifier, channel: "sms" }
    end if
    setStatus("Sending code…")
    StartApi(m, { method: "POST", path: "/auth/request-code", body: FormatJson(body), tag: "requestcode" }, "onCodeSent")
end sub

sub sendCode()
    sendCodeTo(SafeStr(m.kb.text).Trim())
end sub

sub onCodeSent(ev as object)
    FinishApi(m, ev)
    ' request-code always returns success (anti-enumeration).
    m.step = "code"
    m.prompt.text = "Enter the 6-digit code we just sent to " + m.identifier + "."
    setSubmitButton("Verify")
    showKeyboard("", "pin")
    clearStatus()
end sub

sub verifyCode()
    code = SafeStr(m.kb.text)
    if code = "" then return
    body = { code: code }
    if m.channel = "email" then body.email = m.identifier else body.phone = m.identifier
    setStatus("Verifying…")
    StartApi(m, { method: "POST", path: "/auth/login", body: FormatJson(body), tag: "login" }, "onLogin")
end sub

sub onLogin(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    j = res.json
    if j <> invalid and j.needs_name = true
        m.enrollCode = SafeStr(m.kb.text)
        m.step = "name"
        m.prompt.text = "Almost there — enter your first and last name."
        setSubmitButton("Finish")
        showKeyboard("")
        clearStatus()
        return
    end if
    if res.ok and j <> invalid and j.success = true
        finishAuth()
    else
        setStatus("That code didn't work. Try again.")
    end if
end sub

sub finishName()
    fullName = SafeStr(m.kb.text)
    if fullName = "" then return
    body = { email: m.identifier, code: m.enrollCode, full_name: fullName }
    setStatus("Creating your account…")
    StartApi(m, { method: "POST", path: "/auth/enroll", body: FormatJson(body), tag: "enroll" }, "onEnroll")
end sub

sub onEnroll(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if res.ok
        finishAuth()
    else
        setStatus("Couldn't finish sign-up. Please try again.")
    end if
end sub

sub finishAuth()
    m.top.navigate = { action: "authChanged" }
end sub

sub onLogout(ev as object)
    FinishApi(m, ev)
    ClearSessionCookie()
    m.top.navigate = { action: "authChanged" }
end sub

' ---- Delete account ----
sub onDeleteInit(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    err = ""
    if res.json <> invalid then err = SafeStr(res.json.error)
    if err <> ""
        if err = "no_email"
            setStatus("Your account has no email on file — ask an operator to delete it.")
        else if err = "rate_limited"
            setStatus("Too many code requests. Try again later.")
        else if err = "admin_must_demote_first"
            setStatus("An admin has to be demoted before the account can be deleted.")
        else
            setStatus("Couldn't send a deletion code. Try again.")
        end if
        return
    else if not res.ok
        setStatus("Couldn't send a deletion code. Try again.")
        return
    end if
    m.step = "delete-code"
    m.prompt.text = "Enter the confirmation code we emailed you to permanently delete your account."
    setSubmitButton("Delete Permanently")
    showKeyboard("", "pin")
end sub

sub deleteConfirm()
    code = SafeStr(m.kb.text)
    if code = "" then return
    setStatus("Deleting…")
    StartApi(m, { method: "POST", path: "/api/account-delete", body: FormatJson({ code: code }), tag: "delete-confirm" }, "onDeleteDone")
end sub

sub onDeleteDone(ev as object)
    FinishApi(m, ev)
    res = ev.getRoSGNode().result
    if res.ok
        ClearSessionCookie()
        m.top.navigate = { action: "authChanged" }
    else
        setStatus("That code didn't work. Try again.")
    end if
end sub

' A one-time code is a known length, so making the member leave the keyboard
' and find a button after the last digit is pure friction — a phone just
' accepts it. Submit as soon as six digits are in, and remember what was sent
' so a failed code is not resubmitted on every keystroke of the correction.
sub onKeyboardText()
    if m.step <> "code" then return
    code = SafeStr(m.kb.text)
    if Len(code) <> 6 then return
    if code = m.lastSubmittedCode then return
    m.lastSubmittedCode = code
    verifyCode()
end sub

' ---- Submit routing ----
sub onSubmit()
    if m.step = "identifier"
        sendCode()
    else if m.step = "code"
        verifyCode()
    else if m.step = "name"
        finishName()
    else if m.step = "delete-code"
        deleteConfirm()
    end if
end sub

' ---- UI helpers ----
' Always call this LAST when setting up a step. setSubmitButton() assigns
' `buttons`, which takes focus away from whatever holds it — so focusing the
' keyboard first meant every character the member typed was swallowed.
' `voiceType` is what makes the voice keyboard useful rather than merely
' present: it tells Roku what is being dictated, so "pin" takes digits and
' "email" knows about @ and the common domains. Certification 4.12 asks for
' the component; getting the type right is what the member actually feels.
sub showKeyboard(text as string, voiceType = "text" as string)
    m.lastSubmittedCode = ""
    m.kb.text = text
    m.kb.visible = true
    editBox = m.kb.textEditBox
    if editBox <> invalid
        editBox.voiceEntryType = voiceType
        ' A one-time code is exactly six digits; saying so stops the member
        ' typing a seventh and stops voice entry running on.
        '
        ' Only ever SET for the code. maxTextLength = 0 does not mean
        ' "unlimited" — it means zero characters, which silently made the email
        ' and phone fields refuse every keystroke. Anything that is not the
        ' code keeps the component's own default.
        if voiceType = "pin" then editBox.maxTextLength = 6
    end if
    m.actions.translation = [90, 860]
    ' Between the keyboard and the buttons. It used to sit at a fixed y that
    ' the two-button group grew down into, so "That code didn't work" was
    ' printed straight over "< Back".
    m.status.translation = [90, 790]
    focusKeyboard()
end sub

sub setSubmitButton(label as string)
    m.actionKeys = ["submit", "back"]
    m.actions.buttons = [label, "< Back"]
    m.actions.visible = true
    ' Deliberately NOT setting focusButton here: assigning it takes focus away
    ' from whatever has it, and this runs while the keyboard is meant to be
    ' focused — which silently swallowed everything the member typed.
    ' focusActions() sets it instead, at the moment focus actually moves.
end sub

sub focusActions()
    m.zone = "actions"
    m.actions.setFocus(true)
    ' After setFocus, not before: a focusButton set on an unfocused group is
    ' overridden when focus arrives.
    m.actions.focusButton = 0
end sub

sub setStatus(msg as string)
    m.status.text = msg
    m.status.visible = true
end sub

sub clearStatus()
    m.status.visible = false
end sub

' While entering text, Down leaves the keyboard for the submit button.
'
' That only works if the Keyboard *declines* Down so it bubbles up here, and
' Roku firmware differs on whether the bottom row passes it along. ✱ is the
' backup. Down is confirmed working on a Streaming Stick 4K (OS 15.3), and ✱
' stays for the older hardware this channel targets.
function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if m.zone = "kb"
        if key = "down" or key = "options"
            focusActions()
            return true
        end if
    else if m.zone = "actions" and m.kb.visible
        ' Only leave for the keyboard from the top button. This group is
        ' vertical, so swallowing every Up made the button above the focused
        ' one unreachable — with "Send Code" above "< Back", the whole point
        ' of the screen could not be selected.
        if key = "options"
            focusKeyboard()
            return true
        else if key = "up" and m.actions.focusButton = 0
            focusKeyboard()
            return true
        end if
    end if
    return false
end function

sub focusKeyboard()
    m.zone = "kb"
    m.kb.setFocus(true)
end sub
