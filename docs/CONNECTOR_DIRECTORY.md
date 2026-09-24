# Anthropic Connectors Directory submission

The copy-paste packet for listing the MCP server (`https://showpicker.club/mcp`,
see `docs/ARCHITECTURE.md#mcp-server`) in Claude's Connectors Directory, the
same way `docs/APP_STORE_SUBMISSION.md` is for the App Store.

Once listed, members find **Show Picker Club** in Claude's connector browser
and connect in one click, instead of pasting a URL as a custom connector.

## Who can submit

The submission portal lives in claude.ai **organization settings**, so it
needs a Claude **Team or Enterprise** organization, and the person submitting
must be an org **Owner / Primary owner** (on Enterprise, anyone with a custom
role carrying the Directory permission). An individual Pro/Max plan can't
submit. Portal: <https://claude.ai/admin-settings/directory/submissions/new>.
Status and reviewer feedback show up at
<https://claude.ai/admin-settings/directory/submissions>. Escalations:
`mcp-review@anthropic.com`.

Submitting is a human step on purpose: the Compliance step is seven policy
acknowledgments made on the club's behalf.

## Before you submit

- **Run every tool in Claude.** The portal asks you to confirm you've done
  this, either in the MCP Inspector or with the server added as a custom
  connector. The Test & launch step says so explicitly.
- **Populate the demo account.** Reviewers need "a fully populated account".
  The demo account (`DEMO_LOGIN_EMAIL` / `DEMO_LOGIN_CODE`) should have shows
  on all four lists, at least one private group with another member in it who
  also has shows, and a card on that group's Watch Next board. Without a
  group, the group tools return errors during review. The demo resets an hour
  after each login, which is fine for a reviewer: the reset restores the
  baseline and doesn't touch the connection.
- **Check the pre-submission checklist**
  (<https://claude.com/docs/connectors/building/review-criteria>).
  `scripts/mcp-test.mjs` pins the parts it can: every tool has a title and an
  explicit hint, anything that changes existing data is `destructiveHint:
  true`, no description or server instruction tells the model how to behave,
  names are ≤ 64 characters, and list responses are paged.

## Portal steps and answers

### Connection

- **Server URL:** `https://showpicker.club/mcp`
- **Transport:** Streamable HTTP
- **How users reach it:** Universal URL (one URL for everyone)

### Tools

Sync automatically from the server. Expect 10 read-only and 14 write tools,
none flagged. If any are flagged, fix them in `functions/_shared/mcp-tools.js`
before submitting, not in the portal.

### Listing

- **Server name:** Show Picker Club
- **Tagline** (55 max, this is 48): `Your TV and movie lists, and your friends' picks`
- **Description** (2,000 max):

  > Show Picker Club keeps track of what you're watching, what you're waiting
  > on, what you loved and what's next, and lets you see the same for the
  > people in your private groups. Connect it to Claude and use your lists by
  > chatting.
  >
  > Ask what's on your Next Up list and have Claude pick something for
  > tonight. Add a show you just heard about, move one to Loved when you
  > finish it and rate it, or jot a private note. See what your group-mates
  > are watching that you aren't, search your groups' libraries by title,
  > network, genre or cast, and check what's trending across the club.
  > Recommend a show to a group, answer a group-mate's recommendation, or
  > create a group and get an invite link.
  >
  > The connection acts as you, with exactly the access you have in the Show
  > Picker Club app: your private notes stay yours, and other people's lists
  > are visible only through groups you share. When you connect you choose
  > read-only or read-and-change, and you can disconnect at any time from the
  > app or showpicker.club/connected-apps. It can't join groups for you,
  > change your household or touch your account.
  >
  > Show Picker Club is free, on iPhone, iPad, Mac, Apple TV, Apple Watch,
  > Roku and the web. Signing in with email, Apple or Google during setup
  > creates an account if you don't have one.

- **Categories** (1–5): choose from the portal's list. The closest fits are
  entertainment/media, lifestyle, and productivity/personal organization.
- **Documentation URL:** `https://showpicker.club/connect` (the setup steps,
  plus a "What it can do" section listing every tool and the daily limits)
- **Privacy policy URL:** `https://showpicker.club/privacy` (includes the
  "AI apps you connect" section)
- **Support contact:** patrick@patrickturner.net
- **Icon:** `ios/ShowPickerIOS/Assets.xcassets/AppIcon.appiconset/icon-1024.png`
  (1024×1024 PNG, the App Store icon)
- **Slug:** `show-picker-club`. It's permanent once published.

### Use cases

- **Primary use cases:**
  1. Deciding what to watch: "What's on my Next Up that's under an hour?"
  2. Keeping lists current by chatting: add a show, move it when you start
     or finish, rate it, add a note.
  3. Seeing what friends are watching: group-mates' lists, group trending,
     the group Watch Next board.
  4. Recommending shows to a group and answering recommendations.
- **What users need first:** a Show Picker Club account (free, created
  during the connect flow if they don't have one). No paid plan.
- **Reads, writes, or both:** Both. Write access is optional at consent.

### Company

- **Company:** Show Picker Club (operated by Patrick Turner)
- **Website:** https://showpicker.club
- **Primary contact:** pre-filled from your account

### Authentication

**OAuth with dynamic client registration.** Details a reviewer may ask about:

- **Discovery:** the 401 from `/mcp` carries `WWW-Authenticate: Bearer
  resource_metadata=…/.well-known/oauth-protected-resource/mcp`, and the
  authorization server metadata is at
  `/.well-known/oauth-authorization-server`.
- **Flow and tokens:** PKCE S256 required. Access tokens last 1 hour; refresh
  tokens last 90 days and rotate on every use. Revocation (RFC 7009) is at
  `/oauth/revoke`.
- **Scopes:** `shows:read` and `shows:write`. The member can untick write on
  the consent screen.
- **Redirect URIs:** any `https://` redirect registered via DCR, so no
  per-client allowlist is needed for Claude's callback.

### Data handling

- **API ownership:** our own API. `/mcp` calls Show Picker Club's own
  endpoints on the same domain.
- **Personal health data:** No.
- **Sponsored content:** No.

### Test & launch

Give the reviewer this, with the real values from the Cloudflare secrets
`DEMO_LOGIN_EMAIL` and `DEMO_LOGIN_CODE`. Type the values into the portal
only; never commit them here.

> 1. Add the connector (`https://showpicker.club/mcp`) in Claude.
> 2. Claude opens Show Picker Club's sign-in page. Choose **Continue with
>    email** and enter `<DEMO_LOGIN_EMAIL>`. No email is sent to this
>    account; enter the code `<DEMO_LOGIN_CODE>`.
> 3. On the consent screen leave **Make changes** ticked and choose
>    **Allow**.
> 4. The account has shows on all four lists and belongs to the group
>    "<name>" with <member>, who has their own lists and a recommendation on
>    the group's Watch Next board. Try: "What's on my Next Up list?", "What
>    is <member> watching?", "Add The Bear to my Watching list", "Move it to
>    Loved and rate it 9", "Archive it".
> 5. Changes to the demo account are reset automatically an hour after
>    sign-in.

Then confirm you've run every tool yourself.

### Compliance

Seven acknowledgments: directory guidelines, first-party API usage,
financial transactions, AI media generation, prompt injection, conversation
data collection, public documentation. Each is true for this server:

- It calls only our own API.
- It moves no money and generates no media.
- Its tool text describes rather than instructs.
- It collects nothing from the conversation beyond each tool's arguments.
- Its documentation is public at `/connect`.

### Review

Read it through and submit. Short-answer warnings are shared with the review
team, so fill in the use cases rather than leaving one-liners.

## After it's listed

- The directory card is how most members will find it, so point
  `/connect`'s **Add to Claude** button at the listing and keep the
  custom-connector steps as the fallback.
- The submissions dashboard shows server health and usage once published.
- A change to a tool's name, annotations or behavior is a change to what was
  reviewed, so re-check it against the checklist before it merges.
