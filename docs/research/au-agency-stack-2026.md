# AU residential agency stack (desk prior)

Date: 2026-08-17
Status: prior for visit card V3 — **not this shop until confirmed on site**
Use: walk-in guesses only. V3 stays pending.

## Verdict

A typical AU **sales + PM** shop is two systems, not one:

- **PM / trust:** PropertyMe, or MRI Property Tree, or Reapit PM (ex Console Cloud)
- **Sales CRM:** Reapit Sales / Agentbox, VaultRE, Rex, or Box+Dice
- **Forms:** REI Forms Live (most states) or Realworks (QLD / REIQ)
- **Talk:** PMS inbox + SMS + email. WhatsApp is common and often off-file
- **Pay:** PMS payments (MePay / Console Pay / DD) plus the trust bank

Do not assume this office is on PropertyMe. Confirm V3 on the visit.

## Fact check

| Claim | Grade | Source |
|---|---|---|
| PropertyMe used by 6,400+ agencies, ~1.9M properties, 35k+ professionals | B | PropertyMe site (vendor); EQT 4 Dec 2025 said 6,000+ agencies / ~1.9M rentals |
| EQT majority investment in PropertyMe | A | [EQT announcement](https://eqtgroup.com/en/news/eqt-to-invest-in-propertyme-a-leading-australian-cloud-based-proptech-company-2025-12-04) |
| PropertyMe, Property Tree, Reapit PM are the three PM/trust incumbents | B | Multiple 2026 AU comparisons; no independent census of every agency |
| Many agencies run PropertyMe for PM and a separate sales CRM | B | [Horizon AI, reviewed 4 Aug 2026](https://horizonai.com.au/resources/propertyme-vs-reapit-ai-automation) |
| Agentbox is now Reapit Sales; Console Cloud is Reapit PM | A | Reapit / vendor naming |
| Realworks integrates Vault, Property Tree, PropertyMe, Reapit PM, Reapit Sales | B | REIQ Realworks update (vendor/association) |
| Kolmeo / Ailo exist as challengers | B | Public pricing and press |
| **This shop's PMS** | E | Not seen. Do not code against PropertyMe clicks until V3 is filled |

## What to look for on the visit (V3 checklist)

1. State / territory (drives forms and notice names).
2. PM system logo on the PM's screen.
3. Sales system (may be different).
4. How rent is receipted (MePay / bank file / BPAY).
5. Forms product.
6. Where tenant late-rent messages actually go (PMS SMS vs personal phone vs WhatsApp).

## So what for us

Sit on whatever they open. First loop must not require write API. v0 is export/CSV + draft. If they are on PropertyMe, AiMe already drafts arrears — ask V8 whether that is still the curse.
