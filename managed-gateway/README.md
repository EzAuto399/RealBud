# RealBud managed AI backend

Local implementation of authenticated fixed-provider forwarding, exact usage accounting, retail caps, versioned rates, private costing and Square billing fixtures. Automatic account-balance sync is a default-off seam; automatic per-client historical usage remains unconfigured. This service belongs off the office device in a future deployment. It does not load into the desktop or change Hermes.

**No production rate schedule, provider route, portal identity provider, host authority, payment processor or deployment is configured.** The payment composition rejects live and sandbox collection. All included test prices, entities, grants and receipts are synthetic.

## Run locally

Node 24+ with `node:sqlite`; the repository's existing TypeScript dependency is sufficient. From this worktree:

```sh
pnpm exec tsc -p managed-gateway/tsconfig.json
node --experimental-strip-types --test managed-gateway/*.test.ts
node --experimental-strip-types managed-gateway/demo.ts
node --experimental-strip-types managed-gateway/benchmark.ts
```

The demo is finite and offline. It writes an explicitly labelled local invoice and a simulated payment receipt to `managed-gateway/evidence/demo/`. `checkout.invalid` is an inert test address. No network service or background process is left running.

## Entry points

| Module | Responsibility |
| --- | --- |
| `contracts.ts`, `auth.ts` | Scoped canonical Ed25519 grant, strict request validation, required live execution authority |
| `gateway.ts`, `abort.ts` | Admission, reservation, once-only dispatch, streaming, deadline/revocation/cancellation |
| `direct-provider.ts`, `messages.ts` | Fixed DeepSeek/Kimi text/thinking/tool stream fixtures; full supported assistant continuation; default-off transport |
| `attempts.ts` | Immutable v2 parent identity, deadline and budget, with signed child calls |
| `square.ts` | Accepted usage statements, order then draft invoice, raw signed webhooks, retrieved partial/manual payments and refunds |
| `report-import.ts`, `deepseek-balance.ts`, `openai-costs.ts` | Synthetic report fallback; operator-only DeepSeek balance and OpenAI org-costs polling; neither is a client invoice |
| `openai-provider.ts` | Explicit pinned text model, hard context/output ceilings, strict usage parser; no retries |
| `database.ts`, `ledger.ts`, `money.ts` | Durable atomic reservations, append-only events, exact arithmetic, credits and reconciliation |
| `private-costs.ts` | Operator-only cost/FX/margin provenance; unpublished rate proposals; actual provider cost evidence |
| `billing.ts`, `local-payment.ts` | Monthly local invoice close, local hosted-checkout simulation, signed settlement and refunds |
| `http.ts`, `invoice-html.ts` | Dedicated HTTP service factory, tenant-scoped portal API, printable invoice |

Current phase 2 contracts and proof are in [PHASE2.md](PHASE2.md). The original demo/evidence remain the earlier local-simulator checkpoint.

Detailed decisions, the core integration contract, proof and deployment gates are in [the handoff](../docs/REALBUD-MANAGED-AI-BILLING-2026-09-15.md).

The root `pnpm test` discovery does not include this separate off-device service. Run the explicit managed-gateway command above. Production packaging must keep `testing.ts`, tests, `demo.ts`, `benchmark.ts` and `evidence/` out of its runtime bundle.
