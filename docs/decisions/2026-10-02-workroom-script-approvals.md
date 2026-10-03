# Workroom document scripts run without a card — 2 October 2026

Status: owner decision ("yeah sure", in reply to "Should Bud run scripts inside its own private workroom without asking each time?"), scoped by RealBud so it cannot become an exfiltration route.

## Decision

Bud's terminal commands no longer each need an approval card **when all of the following hold**; anything else keeps the existing per-instance card:

1. The command runs one of Hermes' reviewed bundled document scripts — `skills/productivity/{xlsx,docx,pdf,powerpoint}/scripts/*.py` inside the **selected, hash-verified runtime** — with that runtime's own venv Python, or is a plain read of a file (`cat`/`head`/`wc`/`ls`) inside the workroom.
2. Every path argument resolves inside Bud's private workroom (`<DATA_DIR>/vault`); no `..`, no symlink escape, no absolute path elsewhere.
3. The command is a single invocation: no shell chaining, pipes, redirects outside the workroom, subshells, `env`/`eval`, backgrounding, or heredoc code.
4. Scripts with network or outbound side effects are excluded even from the bundled set (`pdf_secure.py` is allowed — local; nothing in the four folders fetches URLs; `extract_marker.py` is excluded because it may download models).

Arbitrary Python or shell, network tools, files outside the workroom, and every send/pay/sign/notice path keep their cards. A command that does not parse cleanly is treated as unknown and asks.

## Why scoped

Bud reads untrusted content (mail, pages, CRM, bank text). An unrestricted "run any script" would let injected content run code that sends office data out without a card, undoing the read_page, mailbox and connector protections. The reviewed document scripts are fixed code, verified with the runtime, and are what Bud should use for Word, Excel, PDF and PowerPoint work.

## Correction after security review (same day)

The premise "anything else keeps the existing per-instance card" was false for the pinned Hermes: in `manual`/`smart` approval mode Hermes only calls RealBud's approval callback for commands its dangerous-pattern detector flags (`tools/approval.py` `check_all_command_guards`); `curl … -d @file`, `python3 /tmp/x.py`, `cat ~/.ssh/id_rsa` and `export PATH=…` ran with no card (confirmed by running `detect_dangerous_command`). Consequences:

- The workroom auto-approve ships **off** (`WORKROOM_AUTO_APPROVE = false` in `server/drivers/acp/core.ts`) until both land: (1) the Ask worker cannot reach the network except loopback (macOS `sandbox-exec`; Windows firewall rule still to do) plus `approvals.deny` globs for network tools on every platform; (2) the classifier fixes from the review (glued options, bare relative outputs, absolute venv Python with `-E -s`, pinned script hashes, numeric words).
- The network boundary is the real control for exfiltration; the card is not, because most commands never reach it.
