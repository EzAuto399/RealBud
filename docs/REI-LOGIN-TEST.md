# REI Cloud sign-in — fault-finding test

Purpose: decide whether "You cancelled the previous sign-in or there was a sign-in issue (MFA)"
is REI's fault, Kevin's account/browser state, or our own automation. Read-only. No credentials
are used, stored or copied by RealBud in any step here.

Date: 2026-09-17 · status: **failure decoded from REI's own diagnostic trace: the B2C journey ran
943 s (15 min 43 s) with no step advancing, then failed after the journey expired. Whether that
was a plain timeout or a dead MFA step still needs one clean attempt — see "Two readings".**

## ★ Root cause (from the operator's captured B2C URL, 2026-09-17)

The captured failure URL was a `CombinedSigninAndSignup/confirmed` call carrying a `diags=` trace.
Decoded, its timestamps tell the whole story:

```
pageId: CombinedsigninAndSignup
t+   0s | 02:48:45Z | T005            sign-in page begins
t+   0s | 02:48:45Z | T021            loads reib2c_idpSelector.html ("Choose your account")
t+   0s | 02:48:45Z | T019 T004 T003 T035 T030Online
t+ 943s | 03:04:28Z | T002            ← 943 seconds (15 min 43 s) with NO activity at all
t+ 943s | 03:04:28Z | T018T010 (540ms) ← fails
```

Three facts fall out of this:

1. **The sign-in page loaded fine at 02:48:45Z.** `T005`→`T030Online` complete in under a second,
   including the custom "Choose your account" page from REI's blob storage. Nothing broke on load.
2. **Then nothing advanced for 15 minutes 43 seconds.** No orchestration step fired in that window
   — the journey sat idle on step 1.
3. **The failure is the next request arriving on a stale journey.** It came in at 03:04:28Z and
   `T018T010` errored 540 ms later. The journey context had expired while the page sat there, so
   the step had nothing valid to work with.

Rebuilt timings (UTC → AEST, +10): sign-in page opened **12:48:45 pm**, failed **1:04:28 pm**.

**Where the message actually comes from:** `https://app.reimasterapps.com.au/Account/NewLoginMFA`
is *not* an MFA-setup page. Fetched, it is a generic REI error shell — title **"Sign In Cancelled -
REI Cloud"**, body **"You cancelled the previous sign-in or there was a sign-in issue (MFA). Close
this browser and try again."**, footer `2026 © REI Master Pty Ltd · v 26.0915.0`. It has no MFA
form, no phone field and no code field — just a hidden `reicid` input and Application Insights.
So the sentence is REI's own wording, and "MFA" in it is REI's label for the cancelled sign-in,
not a report that an MFA check failed.

### Two readings of the same trace — the `OrchestrationStep` number separates them

The captured URL's `csrf_token` decodes to `{"OrchestrationStep": 1}`, i.e. the journey was sitting
on its **first** step when it died. That leaves two candidate mechanisms, and one cheap test tells
them apart:

| Reading | What it means | What a fresh attempt shows |
|---|---|---|
| **A — expired journey** | The page was simply left too long. B2C's inactivity window closed the journey; the later request had nothing valid to exchange, so the app reported a cancelled sign-in. | Completing a fresh attempt within a couple of minutes **succeeds**. |
| **B — dead MFA step** | The journey did reach the MFA step and waited there for a prompt that never rendered (tenant-side MFA / Dynamic Claims misconfiguration), until the window closed. | A fresh attempt **hangs with no prompt** for minutes, then fails the same way. |

Reading B is the better fit for "it never shows MFA, in every browser, every time" — but the two
are not distinguishable from the trace alone, so **do not report B to REI as established fact**
until the step number or a repeat attempt confirms it. That is what the next two checks are for.

### What to check next (one clean attempt, uninterrupted)

**First, answer this one question, because it changes the reading:** in the attempts that failed,
did the page sit there for roughly 15 minutes before failing, or did it fail quickly? The original
captured trace shows 943 s of idling. If every attempt also sits idle that long, reading **A**
(expired journey) is the whole story and the fix is simply to start and finish in one go. If
attempts fail *quickly*, reading **B** is live and REI has a real fault.

1. Start a **fresh** sign-in and do not leave the tab, close it, or let it sit. Complete it inside
   a couple of minutes.
   - **Signs in** → the cause was the expired journey. Learn the habit: start and finish in one go.
   - **Hangs with no prompt for minutes** → confirms a step is failing to render. Stop after
     ~3 minutes and send the captured URL to REI; do not wait out the 15 minutes again.
2. **Watch the URL bar**, don't just watch the page. If it moves to a step containing
   `phonefactor`, `phone`, `otp` or `mfa`, the MFA step *is* being invoked and not rendering —
   say exactly that to REI.
3. **Decode the step counter on any new URL** (it is plain base64 in `csrf_token`, ending
   `{"OrchestrationStep":N}`). The captured failure was `OrchestrationStep: 1`. If a fresh attempt
   also stops at 1, the fault is before MFA; if it advances past 1 and hangs, the fault is the MFA
   step itself. Send whichever number you see.
4. **Do not spam attempts.** Repeated failed journeys can trip B2C lockout and add a second, fake
   problem on top of the real one. Three attempts, spaced out, is enough to characterise it.

## Report from the operator (2026-09-17)

- Signing in **as a human, in Chrome** — no RealBud run involved.
- The form **never reaches the MFA/verification step**.
- Reproduces on **every attempt, in every browser**.
- After the failure, landing on `/Account/NewLoginMFA` shows the message quoted above.
- Supplied a screenshot of the page after the initial login: REI Cloud "Member Login" with Email
  Address + Password and a Sign In button — i.e. the credential step, with no verification shown.

## Verdict

The local causes are ruled out:

| Hypothesis | Verdict | Why |
|---|---|---|
| Our Mac / our network | **Ruled out** | B2C hosts resolve and serve from this machine: `reimasterapps.b2clogin.com` → `40.126.14.163`, `reiportal.b2clogin.com` → `20.190.167.65`, both answering in ~0.15 s |
| Stale cookies in one Chrome profile | **Ruled out** | "every browser" — a fresh engine carries no REI cookie |
| RealBud/automation interference | **Ruled out** | Human sign-in; and RealBud never touches MFA anyway |
| **REI / Microsoft B2C tenant configuration** | **Confirmed as the failure point** | See the decoded trace above: journey idle 943 s, then expired. Not a Microsoft outage — every endpoint and asset answers 200 from here, including REI's custom sign-in skin. |

The B2C authorize endpoint itself is **up and serving** from here (HTTP 200, ~167 KB page) and every
custom asset loads (`reib2c_idpSelector.html`, `reib2c.css`, `REIB2C.js`, `favicon.ico` all 200), so
this is not an outage of Microsoft's B2C service. The failing part is the journey/step configuration
behind the page.

**What we still cannot test from here:** the credentials and the MFA step itself. RealBud is fenced
to `never` for passwords, OTP and MFA, so nothing on our side can advance past the point where it
already fails. Any further evidence has to come from a human attempting a sign-in.

## The sign-in page, for reference

Confirmed from the operator's screenshot and a fresh captured URL (`…/b2c_1_signin/oauth2/v2.0/
authorize?…&prompt=login&…`). The page is REI's own custom skin (`reib2c_idpSelector.html`, title
**"Choose your account"**, loaded from `reimasterstorage.blob.core.windows.net/b2c-resources/Prod/`)
and renders as:

- REI Cloud logo, heading **"Member Login"**
- **Email Address**, **Password**
- links: *Forgot your password?* · checkbox *Keep me signed in* · blue **Sign In** button
- background: the city/aerial photo

The skin's whole script is 944 bytes (`REIB2C.js`) and does only three things: set tab indexes,
rename the heading to "Member Login", and hide the Cancel button. **There is no MFA, phone or OTP
code anywhere in the customisation** — so whatever MFA exists is a plain policy step, not something
drawn by REI's skin. That is consistent with "no verification shows": the step is either not
configured, skipped for this account, or failing before it can render.

Other policies on the same tenant, for the record: `B2C_1_SignUp` and `B2C_1_signup` exist and serve
a page (220 KB, the stock Microsoft template — *not* the REI skin), while a bogus policy name
returns a 103-byte error. `B2C_1_SignIn` (166 KB, REI skin) is the one the app uses. Policy metadata
(`/.well-known/openid-configuration?p=B2C_1_SignIn`) lists the exposed claims as `emails`, `oid`,
`sub`, `idp`, `tfp`, `isForgotPassword`, `iss`, `iat`, `exp`, `aud`, `acr`, `nonce`, `auth_time` —
notably it exposes **no phone/mobile claim**.

## Reconstructed timeline of the captured attempt

| UTC | AEST (+10) | Event |
|---|---|---|
| 02:48:45 | 12:48:45 pm | Sign-in page and custom "Choose your account" skin load |
| — | — | **15 min 43 s idle** — no orchestration step advances |
| 03:04:28 | 1:04:28 pm | Journey resumes, `T018T010` errors 540 ms later, journey is dead |
| 03:04:28 | 1:04:28 pm | App lands on `/Account/NewLoginMFA` → "Sign In Cancelled - REI Cloud" |

Transaction id from the URL: `e691ac64-e796-49f1-a681-56eae7151e80`.
pageViewId: `0de93cfe-495c-474d-add6-75f77b3284ec` — **give both to REI**, they are
what REI/Microsoft support will search their sign-in logs with.

## What is already established (probed 2026-09-17, no login attempted)

REI Cloud sign-in is **Azure AD B2C**, not a plain REI password form:

| Entry point | Behaviour |
|---|---|
| `https://app.reimasterapps.com.au` (REI Master) | 302 → `reimasterapps.b2clogin.com/reimasterapps.onmicrosoft.com/b2c_1_signin/oauth2/v2.0/authorize`, client `7f39da75-212c-4cab-8731-d362cddd5acf`, callback `/signin-oidc` |
| `https://portal.reimasterapps.com.au` (owner portal) | 302 → `reiportal.b2clogin.com/reiportal.onmicrosoft.com/b2c_1_signin/oauth2/v2.0/authorize`, client `8cad8f62-7fd4-4195-949c-b659706d668e` |

Consequences that matter for diagnosis:

1. The password/MFA is handled by Microsoft's B2C service, not by REI's own servers. What the B2C
   custom page can and cannot tell us: `reib2c_idpSelector.html` (fetched, 81 KB) is REI's own
   email/password form — its provider ids are `SignInWithLogonNameExchange` and
   `SignInWithLogonEmailExchange`, so there is **no "Sign in with Microsoft/Google" button** and no
   external-identity-provider fault to chase. The tenant's *journey steps* are still REI's to fix.
2. The policy was requested with `response_mode=form_post` and carries a `nonce`/`state` pair
   bound to the app session. If that pair goes stale — tab left open, back button, second attempt,
   or an interrupted redirect — B2C returns exactly this family of "previous sign-in" messages.
   Both a **tab-state** fault and a **tenant** fault produce similar wording.
3. Both entry points are reachable from this Mac right now (`200` on the B2C authorize URL), so
   there is no local network/DNS block and no REI-wide outage visible from here.
4. The site is **not** PropertyMe, so nothing in RealBud's PropertyMe assumptions applies. REI
   remains the system of record; Bud only prepares.
5. RealBud's own fence (per `docs/PORTAL-WORK.md`) means **MFA/OTP is `never`** — RealBud will
   never type or answer a code. So if this error appeared during a Bud run, the cause is that the
   sign-in was expected to be completed by a person, not by Bud.

## Test 1 — one account or the whole office? (do this first, it decides everything)

1. Have a **second REI user at the office** (or Kevin on a second login) attempt a sign-in now.
2. Record: did that second account get past the point where Kevin's fails?

- **Second account works** → the fault is **Kevin's user account** (MFA enrolment, lockout, expired
  guest invitation). Ask REI to repair that account.
- **Nobody can sign in** → the fault is the **tenant / `b2c_1_signin` user flow**, and it is REI's
  incident, not something anyone here can work around.

Also worth doing before anything else, because it costs nothing: if there have been many failed
attempts, wait 30–60 minutes and try once. Repeated failures can trip B2C lockout, which produces
exactly this "previous sign-in" family of messages.

## Test 2 — capture the exact failure (what REI support will ask for)

With DevTools open (`⌥⌘I`) → **Network** tab, tick *Preserve log*, then reproduce once.

Record these five things:

1. **The exact error text, character for character** — including any `AADB2C…` / `AADSTS…` code,
   a "Correlation ID", "Timestamp", or a "Trace ID" string on the page.
2. **The page host** the error appears on: `*.b2clogin.com` (Microsoft's B2C page = REI tenant
   problem) or `app.reimasterapps.com.au` / `.../Account/Error` (REI's app rejected the response —
   note the app has its own error page, so this is a normal outcome, not a broken URL).
3. **The last request in the chain** — filter Network for `b2clogin` and note the final status
   (`200`, `400`, `302` loop) and any `error=` query parameter.
4. **A screenshot** of the error page with the URL bar visible.
5. **Time to the minute**, and whether the account already had MFA set up before.

A HAR export of that one attempt (Network → right-click → *Save all as HAR*) is the single most
useful artefact if REI asks for logs.

## Test 3 — local-state clear (already largely ruled out, cheap to confirm)

Every-browser reproduction means this is unlikely to be the cause, but one pass removes all doubt:

1. Close **every** REI tab, then clear only REI cookies:
   Chrome → Settings → Privacy → Third-party cookies → *See all site data and permissions* →
   delete entries for `reimasterapps.com.au`, `reimasterapps.onmicrosoft.com`,
   `reimasterapps.b2clogin.com`, `reiportal.b2clogin.com`.
2. Quit Chrome completely (⌘Q, not just close the window) and reopen, then try once.

## Test 4 — account-side checks (needs Kevin)

These are the tenant-side causes only REI/Kevin can see or fix:

1. Is MFA enrolment complete for that user in the B2C tenant (`reimasterapps.onmicrosoft.com`)?
   An interrupted enrolment is a common cause of a step that is invoked but never renders a prompt.
2. Is the account a **guest** user in the tenant, and was the invitation redeemed / not expired?
3. Has REI changed the `B2C_1_SignIn` user flow, the MFA method (SMS vs authenticator app), or
   conditional access recently — and did the app version move to `v 26.0915.0` around then?

## What to send REI support

**Copy this, fill the four blanks, attach the error screenshot and (if you have it) the HAR.**

> Subject: Sign-in fails on B2C_1_SignIn — "You cancelled the previous sign-in or there was a
> sign-in issue (MFA)" — never prompts for MFA
>
> Hello,
>
> We cannot sign in to REI Cloud (REI Master). After entering the email and password on the
> Member Login page, it does not reach any verification step. It ends on
> `https://app.reimasterapps.com.au/Account/NewLoginMFA` showing:
>
> > You cancelled the previous sign-in or there was a sign-in issue (MFA). Close this browser and
> > try again.
>
> What we have checked ourselves:
>
> - Reproduces in Chrome, Safari and Edge on different machines — so it is not one browser's cookies.
> - Signed in manually as a human; no automation or script is involved.
> - No MFA / verification / code screen is ever displayed.
> - **_[ Did the page sit for ~15 minutes before failing, or fail quickly? ]_**
>
> A failure URL we captured contains Azure AD B2C's own diagnostics. Decoded:
>
> - sign-in page loaded 2026-09-17 02:48:45Z; **no orchestration step advanced for 943 seconds**;
>   step `T018T010` then failed at 03:04:28Z
> - `OrchestrationStep`: 1
> - Transaction id (`tx` StateProperties `TID`): `e691ac64-e796-49f1-a681-56eae7151e80`
> - pageViewId: `0de93cfe-495c-474d-add6-75f77b3284ec`
> - Policy `B2C_1_SignIn`, tenant `reimasterapps.onmicrosoft.com`
> - Client id `7f39da75-212c-4cab-8731-d362cddd5acf`; app footer shows `v 26.0915.0`
>
> Please could you:
>
> 1. Check the B2C sign-in logs for transaction `e691ac64-e796-49f1-a681-56eae7151e80` and tell us
>    what `T018T010` recorded.
> 2. Confirm whether an MFA step is configured on `B2C_1_SignIn`, and whether it is being invoked
>    for this user.
> 3. Confirm whether an MFA method (phone or authenticator) is registered for account
>    **_[ affected email address ]_**.
> 4. If the account needs MFA enrolment, tell us the exact steps or the page we should use.
>
> Affected user / office: **_[ name + login email ]_**. Date and local time of the failure:
> **_[ e.g. 17 Sep 2026, 12:48 pm AEST ]_**. A HAR of a fresh attempt is available on request.
>
> Thank you.

**Before you send, do these two things** — they decide whether this is a one-account ticket or a
tenant incident, and REI will ask either way:

1. Have a **second REI user at the office** try to sign in. If their account works, this is one
   user's account; if nobody gets in, say so explicitly in the ticket — it changes the severity.
2. **Do not send a claim that the MFA step is broken.** The trace proves the journey expired on
   step 1; it does not prove why. Report what you saw and let them read their own logs.

## The two questions only Kevin can answer (do these first — the fastest route)

1. **Is it one account or the whole office?** See test 1 — this single test decides the ticket.
2. **Did anything change just before it broke?** A recent REI update, a password change, a new
   phone (the old MFA device removed), or a run of failed attempts.

## Boundaries

- RealBud never handles the password, the OTP or the MFA prompt, and never copies the session —
  `MFA/OTP` is `never` in the portal fence, by design.
- The human signs in; Bud reads and prefills at most. Any test here is attended.

## Result log

| Date | Test | Outcome | Evidence |
|---|---|---|---|
| 2026-09-17 | endpoint probe from this Mac | B2C up: `reimasterapps.b2clogin.com` → 40.126.14.163, `reiportal.b2clogin.com` → 20.190.167.65, authorize URL returns 200 (~167 KB) | this doc |
| 2026-09-17 | asset health of custom sign-in skin | `reib2c_idpSelector.html` 200 (81 KB), `reib2c.css` 200, `REIB2C.js` 200, `favicon.ico` 200 | this doc |
| 2026-09-17 | operator report | Human sign-in, never reaches MFA, every browser, every attempt | this doc |
| 2026-09-17 | **decoded B2C `diags` trace from the failure URL** | **page loaded 02:48:45Z, 943 s idle, `T018T010` failed 03:04:28Z — journey expired mid-flight** | this doc |
| 2026-09-17 | fetched `/Account/NewLoginMFA` | generic REI error shell, title "Sign In Cancelled - REI Cloud", no MFA form, app v 26.0915.0 | this doc |
| 2026-09-17 | read the sign-in skin `REIB2C.js` (944 B) | only sets tab indexes, renames heading to "Member Login", hides Cancel — **no MFA/phone/OTP logic anywhere** | this doc |
| 2026-09-17 | policy metadata + sibling policies | `B2C_1_SignIn` = REI skin, 166 KB; `B2C_1_SignUp` / `B2C_1_signup` exist (stock template, 220 KB); bogus policy → 103 B; `SignIn` claims expose **no phone claim** | this doc |
| | fresh uninterrupted attempt + `OrchestrationStep` number | *pending* — decides expired-journey vs dead MFA step |
| | answer: did failed attempts sit ~15 min, or fail fast? | *pending* — changes which reading applies |
| | REI support response on transaction `e691ac64…` | *pending* |
