# Modelvia commercial terms per office

Implementation decision, 26 September 2026, on branch `claude/modelvia-live-integration`. Backed by local tests against a stand-in shaped from Modelvia `main` 49327ba. Not deployed, and not checked against the live service.

## Decision

Modelvia refuses every request of a customer that RealBud's client pays for until an active commercial policy is in force (`customer_terms_required`). The gateway now writes that policy when an operator saves an office's AI access. It chooses the billing treatment as follows:

- **Client-funded** for companies listed in `REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES`, which are the owner's office and internal offices. RealBud absorbs the usage, so there is no markup and the receipts show `priceBasis: withheld`. This follows the owner decision in [Modelvia is the only billing source](2026-09-24-modelvia-sole-billing.md) and the live policy `realbud-owner-internal-2026-09-25`.
- **Resale** for any other office, only when `REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS` and `REALBUD_MODELVIA_RESALE_TERMS_REFERENCE` are both set. The routing plan (`routing/MODELVIA-FIRST-REALBUD-CLIENT.md`) makes RealBud the payer and reseller for customer offices, but it records no approved markup, and no signed customer terms exist yet.
- **Nothing** otherwise. The operator's save reports `terms.state: unconfigured`, and provisioning refuses the office with `modelvia_customer_not_ready` until the treatment is decided.

A policy that is already in force is never replaced. Changing how an office is billed is a dated migration at Modelvia.

## Open for the owner

- The resale markup and each customer office's acceptance reference. Today one reference applies to every resale office. A per-office reference would need the operator route to carry it.
- Whether a customer office resold by RealBud should keep billing to RealBud's internal-cost billing account. Modelvia accepts resale on it because the payer is the client, the invoice issuer is the client and the fee is 0. It is still an accounting choice.
