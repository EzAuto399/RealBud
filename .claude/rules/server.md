---
paths:
  - "server/**"
  - "shared/**"
---

# server/ and shared/ conventions

Authority
- Routes are one flat `if (path === … && method === …)` chain in `server/index.ts` (no router); place a new route after the gates it depends on. Add every new `/api/*` prefix to `needsSession` in `server/session-auth.ts`, otherwise it is reachable without the per-boot session token.
- Non-GET `/api/*` must be `application/json`; `/api/company/*` responses are `no-store`. `productDenied` in `server/product-mode.ts` is a hard route denylist in PRODUCT_MODE.
- Company reads/writes go through `authenticated()` and `authorizedScope()` in `server/company/index.ts`: advisory locks in fixed order (lifecycle → member → session → scope), the session re-checked after locking, RLS context set. Department permission is the SQL `scope_allowed()`; do not reimplement it in TypeScript. Member sessions (`x-realbud-member-session`) and execution grants (`x-realbud-execution-grant`) are different credentials and never convert into each other.
- Re-verify identity and permission after every `await` that crosses a lock or host boundary (pattern: `server/company-execution-client.ts`). A UI filter or an enqueue-time check alone is not access control. Never hand a `pg` Pool or its credentials to a worker.

Private storage and revisions
- Use `readPrivateJson`/`writePrivateJson` (`server/private-json.ts`): symlinks, hardlinks, loose modes and foreign uids fail closed as "needs recovery"; damaged files are preserved and hold mutations, never cleared. Writes are temp → fsync → rename at 0600.
- Vault entries (`server/private-vault.ts`) are encrypted envelopes whose name must match; a missing key with a non-empty directory is a hard failure. Workspace identity (`server/workspace-identity.ts`) is immutable; membership changes never alter it.
- Optimistic concurrency is a caller-supplied `expectedRevision` compared inside the lock, answered with 409 and a reload message. Company revisions are decimal strings bounded to int64, not numbers.

Durable execution
- `executeRecipeJob` (`server/job-executor.ts`) enqueues under an idempotency key first; a duplicate key returns `{reused: true}` and never re-runs. Worker input is built from the snapshot persisted at enqueue, not the live job.
- Outboxes (`server/company-outbox.ts`, `server/company-department-outbox.ts`) persist the exact request before dispatch; only a first definitive 4xx rejection clears it, timeouts stay held, and a lost reply is reconciled against the saved intent (receipt id must equal request id), never assumed successful. Archiving is a local acknowledgement, not a remote cancel.
- Case claims are fence + lease + token-hash; every admit/renew/settle bumps the fence and re-asserts liveness after the write; settlement lands in `recovery_required` and is never silently reopened.

Secrets
- Everything persisted or shown passes `redactSecretsInText` (`server/redact.ts`); redaction is deliberately high-precision, so do not add generic hex/base64 heuristics. Child processes get `serviceSafeChildEnv()` (`server/service-child-env.ts`); model adapters strip their own provider keys. Credential-shaped input is rejected in PRODUCT_MODE, not redacted.
- Fixtures use obviously synthetic values (`fictional-*`, `/synthetic/...`): no real keys, mailboxes, customer names or machine paths.

Hermes boundary
- Profiles resolve only through `baseWorkerProfile()`/`hermesProfileFor()` (`server/hermes-profile.ts`); never accept a caller- or model-supplied profile name or directory. `server/hermes-pack.ts` installs by file copy, rewrites the policy block (`approvals: manual`, `cron_mode: deny`) on every install, and rejects `off`/`smart`/`yolo` and the terminal/code/cron toolsets. Model text is data with a sha256 evidence row, never authority. Never launch Hermes.app; never edit Hermes source.

Tests
- Colocated `*.test.ts`; run one with `pnpm exec vitest run <file>`; server-only types with `pnpm exec tsc -p tsconfig.server.json`. `server/testing/setup.ts` gives each file a throwaway HOME, so never read `os.homedir()` at import time.
- `*.integration.test.ts` gate with `describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')` and take the binary dir from `REALBUD_TEST_POSTGRES_BIN`; HTTP company tests read `REALBUD_COMPANY_TEST_URL`. Fake CLIs in `server/testing/` are env-driven state machines (`FAKE_ACP_MODE`, `FAKE_ACP_DUMP`) and must stay dependency-free.

shared/
- Dependency-free, discriminated on literal `kind`/`type`; versioned payloads carry `version` and `purpose` literals inside the validator; validators use `exact()` and reject unknown keys; normalizers throw a user-facing sentence. Server imports with `.ts` extensions, `src/` via the `@shared` alias; keep both working. Operation path lists are exported `as const` and reused as the runtime allowlist.
