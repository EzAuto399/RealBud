# Channels — Bud beyond the window

Date: 2026-08-31
Status: Telegram shipped (bridge + You → Phone). Discord builds next. WhatsApp is
declared with its real constraint. Canonical constraints: `docs/GOAL-PROMPT.md` wins.

RealBud owns every channel. The worker stays per-turn and never knows a channel
exists: an inbound phone message becomes an ordinary Ask turn on the one Bud
thread, and the reply relays back out. A channel is a door to the same desk,
never a second agent, never a new nav place.

## The adapter contract

`server/channels/` holds one adapter per platform behind a shared shape:

- `verify(credentials)` → the platform answers who this bot is, or a
  plain-language throw.
- `start(handlers)` / `stop()` — inbound text in, relayed answers out.
- `status()` → the public shape for `GET /api/channels`: connected, platform
  identity, paired name, last message at. Never a token, never a raw chat id.

Pairing is first-contact everywhere: the first chat to write pairs with this
Mac; every other chat gets one polite refusal. Credentials live in
`channel-<platform>.json` (atomic, 0600) and never appear in API responses or
logs. The poller never runs under VITEST and stops on server shutdown.

## Platforms

| Platform | Mechanism | Status |
|---|---|---|
| Telegram | Bot API long-poll over HTTPS | **Shipped** (`telegram.ts`, You → Channels) |
| Discord | Bot token verify via REST; inbound over the Gateway (native WebSocket, no dep); pair on first DM | **Shipped** (`discord.ts`, You → Channels) |
| WhatsApp | Cloud API is push-only: Meta calls a public webhook. A local-first Mac has no ingress without a tunnel/relay. | Declared. Needs a named relay decision from the owner — do not build a tunnel silently. |
| Slack / Teams / SMS | Same adapter shape when asked | Declared |

Non-text updates are out of scope until a platform proves itself. Media,
reactions, and parse modes are per-platform follow-ups, not the bridge.

## Hard rules

- One Bud thread. Channels never create bots, rooms, or agents.
- A channel answer is the same worker turn with the same boundaries: no send,
  no pay, approvals still land as cards.
- Phone-originated messages are tagged in Ask (`[Telegram · Name]`) so the
  transcript never hides where a message came from.
