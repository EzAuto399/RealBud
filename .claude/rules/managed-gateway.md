---
paths:
  - "managed-gateway/**"
---

# managed-gateway/ conventions

- Off-device service: authenticated fixed-provider model forwarding, exact usage accounting, versioned rates, private costing and Square billing. It is never mounted on the desktop loopback API and never loaded into the desktop.
- Tests: `node --experimental-strip-types --test ./*.test.ts` from this directory; root `pnpm test` does not discover them. `testing.ts` is synthetic fixtures only and must never be imported by `server.ts` or any production composition.
- Credentials come only from env/`.env.local`; providers stay disabled unless `REALBUD_ENABLE_PROVIDER=1`; every adapter needs an injected transport; connector configuration stores an env-var reference, never the secret. Authority is an Ed25519 grant envelope verified against the enrolled issuer; an HTTP body never asserts tenant, company, scope or spend. Error responses never include upstream bodies, stack traces, prompt content or tokens.
- Deployment is a separate authority: `deploy.sh` needs a human `fly auth login` and exported secrets; never run it from a coding session. `DEPLOY.md` states current intent when it disagrees with a script; confirm with the owner. Exclude tests, `testing.ts`, `demo.ts`, `benchmark.ts` and `evidence/` from the runtime bundle; `evidence/demo/` is gitignored and dated evidence is committed deliberately.
