# Bud as office PA: mailbox, research, reminders and CRM reads — 2 October 2026

Status: owner decision. Supersedes the "external sends are simulation-only" line of `docs/decisions/2026-10-01-gmail-w2-w3-operating-model.md` and the Ask Gmail allowlist of three read tools. Keeps `docs/decisions/2026-09-23-browser-task-authority.md` (explicit per-instance approval for pay/sign/send/notice).

## Decision

- **Mailbox (Gmail, Outlook) — full toolkit.** Bud may search, read threads and attachments, create and edit drafts, label, archive and mark read without a card. **Send, reply and forward** run only after the person approves that exact message (recipient, subject, body and attachments shown). Trash needs approval; permanent delete stays blocked. Owner's words: "allow full everything". The single approval on outgoing mail is retained because Bud reads untrusted inbound content and a prompt-injected email must not be able to send on the office's behalf.
- **Web research — free and open source.** A RealBud-owned per-turn tool provides `search` and `read page` as bounded reads (no card). Search is backed by a self-hosted SearXNG instance (open source, no API key, no vendor account), deployed on RealBud/Hermios infrastructure after the owner approves that deployment. Page reads are fetched by RealBud with an SSRF guard and size caps. Hermes safe mode stays on; Hermes' own web plugins stay off.
- **One-off reminders** — dated items on RealBud's own clock that surface on Today and let Bud prepare the follow-up when due. Not Hermes cron; nothing is sent automatically.
- **Hermios CRM reads** — once a member connects their own Hermios, Bud may search and open records with that member's own Hermios access through a RealBud-mounted read-only tool. No deletes, emails or workflows from the CRM side; writes come later with approval.

## Unchanged

Payments, signatures and statutory notices keep explicit per-instance approval. Credentials never pass through Bud. Live customer accounts still need customer authority.
