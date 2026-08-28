# Computer use and browser use in RealBud

Status: current source boundary, 2026-08-27. `docs/GOAL-PROMPT.md` wins any conflict.

RealBud uses computer control to complete a named PM workflow, not to expose a general computer playground. Hermes remains an unmodified external worker behind RealBud's closed action broker. It does not own CUA installation, profiles, policies, receipts or permission decisions and never receives the driver's raw tool catalog.

## Locked topology

```text
PM request / scheduled admitted source
              │
              ▼
RealBud recipe + work receipt + single computer lease
              │ exact work id, recipe/version, origin, expiry
              ▼
Electron main (TCC owner)
  ├─ idle setup host: check_permissions only
  └─ workflow host: pinned CUA Driver 0.19.3
       └─ native version-2 bounded policy
            ├─ isolated browser profile
            ├─ exact credential-free origins
            ├─ seven typed browser operations
            ├─ bounded lifetime and idle timeout
            └─ desktop display disabled
              │
              ▼
typed observation/result → durable broker → Desk proposal/hold
```

Electron is the only process allowed to start the embedded driver, so macOS permissions remain attributable to RealBud. A packaged app resolves only `RealBud.app/Contents/Resources/cua-driver`; a personal CUA app, ambient daemon and `CUA_DRIVER_PATH` override are ignored. Development uses only an explicit development override or this checkout's prepared `dist-native/cua-driver`.

## Permission onboarding

Computer use is progressive setup in You, not a first-launch requirement. The PM chooses **Set up** before Electron asks for anything. The row then verifies exactly three facts: RealBud's private runtime is present, Accessibility is granted to RealBud, and Screen & System Audio Recording is granted to RealBud. Missing grants open only their fixed Privacy & Security panes; **Check again** re-runs the app-owned setup check, and a stale macOS screen result asks for one quit/reopen.

App Management is not a computer-use prerequisite. A separate `cua-driver`, Hermes or personal automation entry shown there is not RealBud's permission owner and must not be enabled, inspected or reused for this flow. Microphone and notification grants belong to dictation/reminders and remain separate just-in-time requests. Permission denial or native startup failure disables only Computer use. A successful setup starts a `check_permissions`-only host; it does not authorize a property case, origin, browser operation, background job or Submit.

The packaged server receives the exact bundled executable path from Electron. It accepts a workflow descriptor only when all of these match:

- macOS, embedded mode and pinned driver 0.19.3;
- the exact packaged executable, a regular executable file and no symlink;
- the exact embedded MCP arguments and two fixed environment values;
- a private regular descriptor, private policy directory and private regular policy file;
- exact version-2 policy bytes and SHA-256 digest;
- one isolated profile, one to eight exact origins and the exact typed tool list;
- valid work/recipe ids, version, start, expiry and idle bounds.

The descriptor is revoked before a host is stopped or replaced. A failed transition therefore makes computer use unavailable instead of leaving a stale socket or policy trusted.

## Admitted CUA surface

The workflow policy allows only:

```text
start_session
end_session
browser_prepare
get_browser_state
browser_navigate
browser_click
browser_type
```

It excludes ambient `list_windows`, generic desktop/window state, screenshots through the desktop route, coordinate input, keyboard shortcuts, clipboard, files, downloads, app launch/kill and every other raw tool. This is enforced by the native CUA policy as well as RealBud's manifest and descriptor decoders. Loopback HTTP is permitted only for the explicit fixture fleet; production origins require HTTPS.

## Browser ownership

Production browser lanes must use a RealBud-bundled Chromium runtime and a separate RealBud-owned profile per lane. They must never import, inspect, attach to or reuse the PM's personal browser, tabs, cookies or default profile. The same bank/PMS account remains serial; a second local browser lane is allowed only for an independent account after resource and simultaneous-session checks.

`agent-browser` is a pinned QA driver only. It gives the fixture walkthrough a deterministic DOM loop, but it is not bundled as Bud authority and is never passed to Hermes. The hybrid bank fixture starts it with a disposable profile, then requires CUA to validate that exact Chromium PID and DevTools endpoint before typed credit observations may reconcile to Desk.

## Money boundary

Bank computer use is observation only. RealBud may read a bounded recent-credit list from one admitted account after the PM handles login/MFA. It may not expose or invoke transfer, payee, payment, allocation, disbursement or trust-reconciliation operations. Raw references are discarded after deterministic matching; credentials, account numbers and raw references do not enter Desk, Ask, logs or receipts. The PMS remains money/legal authority, absence never proves non-payment and discrepancies become held work.

## Current evidence versus remaining work

Source-proven:

- pinned native runtime and version-2 policy generation;
- atomic private policy/descriptor persistence and exact server verification;
- refusal of generic desktop capture, ambient window enumeration and off-origin navigation;
- teardown invalidates the live SDK connection;
- fake-bank login/credit extraction, disposable-profile ownership, exact CUA PID/endpoint validation, digest-only Desk reconciliation and transfer/payee refusal.

Still required before a live beta claim:

- connect a code-owned admitted recipe/work receipt to Electron's start/end owner; the model must not construct that manifest;
- bundle and verify the private Chromium/profile pool;
- name a bank and agency-approved read-only test account;
- exercise login/MFA, selector changes, auth expiry, rate limits, revocation and same-account sessions;
- prove the installed signed app's real Keychain and TCC flow;
- repeat the named vendor operation with human Submit and retain recovery evidence.

Computer History remains deferred. It can become an opt-in, encrypted, case/session/time-bounded recovery receipt only after a stable pinned API and a real reconstruction need; it is never ambient surveillance, Notes, authority or automatic replay.
