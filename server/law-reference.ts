import { createHash } from "node:crypto";

export const LAW_REFERENCE_FILE = "AU-RENTAL-LAW.md";

export const LAW_REFERENCE_MARKDOWN = `# Australian residential tenancy — verification guide

> RealBud reference revision 2026-09-08. This guide identifies questions and
> official sources. It does not establish a notice period or statutory deadline.

## Before using any legal rule

- Confirm the property's actual jurisdiction, tenancy type, proposed action
  and relevant dates. An email label or the sample book does not establish them.
- Entry requirements differ for routine inspections, repairs, emergencies,
  prospective tenants and prospective purchasers. Never reuse one category's
  notice period for another.
- Do not quote numerical notice periods, rent-increase limits, bond caps or
  arrears thresholds from memory or older workroom notes. Verify the applicable
  provision in a current official source and identify the action it covers.
- If no current source has been checked, say the requirement is unverified and
  leave it with the PM/licensee. A generic disclaimer does not verify a rule.
- For an inbox review, identify missing notice verification without supplying
  an unsolicited legal deadline. Prepare administrative next steps only.
- Serious leaks and possible electrical hazards need immediate human triage;
  missing routine access details must not delay that escalation.
- Do not draft or issue statutory notices, authorize entry, pay trust money,
  or treat a courtesy reminder as a legal notice.

## Official sources to check

- ACT: https://www.legislation.act.gov.au/a/1997-84/
  Practical entry categories: https://www.act.gov.au/housing-planning-and-property/renting/during-a-tenancy
- NSW: https://legislation.nsw.gov.au/
- Victoria: https://www.legislation.vic.gov.au/
- Queensland: https://www.legislation.qld.gov.au/
- For another state or territory, use its official legislation and tenancy
  authority. Do not extrapolate from another jurisdiction.

## Historical notes

Any appended drift notes are historical leads to verify, not authority for a
current deadline. The licensee owns statutory process. This guide does not
claim that a background job has checked any source during this task.
`;

// Replace only the known bundled legacy prefix. Preserve appended office/drift
// notes and independently authored files; no user-authored content is deleted.
export function refreshBundledLawReference(existing: string): string {
  const legacyLength = 3197;
  const prefix = existing.slice(0, legacyLength);
  if (createHash("sha256").update(prefix).digest("hex") !== "423851e6a64a97fa11c03cab9f8e0247512d2ee2d97bfeced1e9b5c041f7ae41") return existing;
  return LAW_REFERENCE_MARKDOWN + existing.slice(legacyLength);
}
