# Attended company-member identity mapping

This checkpoint connects a verified website person to an actual company member, with separate member acceptance and owner confirmation. It is the completed identity prerequisite for department execution. It does not claim a department case, start a worker, grant department access, or turn a private source into a shared source.

The owner chooses an active company member in **You → This office → Company member website identity**. That member checks the code on the website, obtains a proof, and enters it using their own company session. The owner sees the verified email and agency; the same website person supplies a separate confirmation proof before the owner confirms. A solo owner can complete both roles. A current office network certificate is required, even for one person. Pending requests, refreshed state and disconnect remain visible after failures.

## Authority and recovery

- The fixed `https://realbud.app/api/company-portal/redeem` endpoint proves current portal identity. The company host independently redeems a narrow 256-bit handle. It never accepts a browser's asserted identity receipt, or forwards a reusable member, provider or website command credential.
- Website issuance requires fresh, current portal identity. SQL stores the handle hash, exact target and request identity. The copied handle expires by the original challenge/authentication deadline (at most ten minutes); the host's redemption receipt is valid for at most sixty seconds. Exact retries retain the original receipt and deadline and repeat the current identity check.
- The company generates and durably stores separate mapping/confirmation challenges and redemption IDs. It reserves the exact request and handle hash before contacting the website. Both company transactions authenticate the real session, member and creating owner again. Confirmation compares the entire provider/person/account/epoch binding against the candidate. Billing ownership supplies no company role.
- Company migration `0007` adds a host authority incarnation, the immutable first-confirmed website tenant association, and historical member bindings. RLS restricts records to the owner or the bound member. A confirmed historical portal subject cannot silently move onto another company member. Unconfirmed candidates cannot permanently reserve another person's identity.
- A shared certificate gate covers each complete company transaction through COMMIT and office certificate renewal. The network proof request runs outside that gate. Certificate and proof deadlines are checked again after database waits. An old certificate cannot be accepted during renewal.
- Owner/member disconnect is terminal. Company restore preserves evidence and the website tenant association, rotates the authority incarnation, revokes restored mappings and retains existing session/case fencing. Only the exact trusted `0005`/`0006` backup shapes upgrade to `0007`; unknown fields and migration checksums still fail.
- Browser retries persist the exact request before sending. A company member session is not newly persisted by this feature. Codes and proofs are not put in URLs or logs. Website proof payload pruning retains identifier tombstones; each person has a bounded lifetime proof history of 1,000 records. No deployed pruning scheduler is claimed.

Website redemption and company commit remain separate transactions. These short-lived proofs do not create atomic revocation across databases. Any later department effect must independently check current portal and company authority. The mapping view's `current` field describes current company/member/host eligibility; it is not a cached authorization to execute work or a live portal revocation check.

## Verification

The authoritative aggregate is [verification.json](../outputs/company-portal-2026-09-22/verification.json); exact source and compiled file hashes accompany it.

| Layer | Evidence |
| --- | --- |
| Focused application regression | 185 tests passed, zero failures or skips, across fourteen files. Includes actual company PostgreSQL, role/isolation/recovery, host startup, existing private remote execution, proof validation and UI codecs. [Receipt](../outputs/company-portal-2026-09-22/final-regression.json) |
| Website tests | 70 tests passed. [Receipt](../outputs/company-portal-2026-09-22/website-suite.tap) |
| Website PostgreSQL | 63 assertions passed, including observed concurrent revocation waits, identity epoch changes, immutable retries, capacity, pruning and direct-access denial. [Receipt](../outputs/company-portal-2026-09-22/website-postgres-final.json) |
| Certificate race | Eighteen company mapping tests, included in the 185 above, cover raw certificate changes during held row reads and both legitimate rotation orders. A separate connection observes the committed candidate before rotation may begin. [Receipt](../outputs/company-portal-2026-09-22/certificate-race-tests.json) |
| Source application | Actual desktop service and rendered UI, owned company PostgreSQL, built Next and separate website PostgreSQL. Five groups cover setup, lost issuance/acceptance/redemption replies, restart, pinned TLS/session checks, mobile layout and terminal disconnect. [Receipt](../outputs/company-portal-2026-09-22/gui-source-final/receipt.json) |
| Compiled application | Same flow using the isolated compiled service and UI. [Receipt](../outputs/company-portal-2026-09-22/gui-compiled-final/receipt.json) |
| Build | Desktop types/UI, website production build and compiled service build passed. This is not a native installer receipt. |

The source/compiled browser flows use fictional identities and preserve only hashes of retry bodies. They inspect the real application run list and company claim receipts and require both to remain empty. Mobile and desktop captures were visually inspected; proof fields are masked in captures.

Earlier failures are retained: the first source startup exposed unsupported TypeScript parameter-property syntax and was fixed with ordinary class fields; the certificate review found and fixed the renewal race; an initial isolated compiled fixture omitted `dist-server/src` and was corrected to match the existing Electron package layout. Passing build output alone did not establish runtime success.

## Next implementation

Admit an existing assigned department case to `prepare-recipe` through the current durable executor. The new target must bind both confirmed requester/decider mappings, executing member, exact company/host incarnation, department revision, case fence, reviewed source/template and website request/review/decision/claim. Add a purpose-specific online proof for this effect; the two mapping purposes stay unable to authorize execution.

Persist a private random claim token before requesting company admission, because the existing generic claim API cannot replay its generated token after a lost reply. Keep the fixed website dispatch deadline separate from renewable company ownership. Recheck both authorities at source/provider entry and result settlement; use explicit case recovery after stale ownership. Background execution needs a deliberately scoped credential rather than a saved general member session. Keep Morning private until a reviewed department source binding exists.

Windows installed GUI/key custody/update/uninstall, a fresh macOS installer/profile, two-device acceptance, hosted migrations/sign-in, real provider/source workflows and customer acceptance remain separate gates. The broader operating-core goal remains active.
