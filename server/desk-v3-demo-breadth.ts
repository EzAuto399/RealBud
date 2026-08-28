// Demo-only V3 breadth. Live books are never invented.
import {
  tenantContactIdFromProperty,
  tenancyIdFromProperty,
  type CaseKind,
  type ContactSafeguards,
  type DeskFileV3,
} from "../shared/desk-v3.ts";

const quietSafeguards: ContactSafeguards = {
  hardship: false,
  dispute: false,
  paymentArrangement: false,
  doNotContact: false,
  preferredChannel: "email",
};

const EXTRA_CASES: Array<{ id: string; kind: CaseKind; holdReason: string }> = [
  { id: "case-maint-prop-oak", kind: "maintenance-intake", holdReason: "Classify and gather evidence only. No dispatch." },
  { id: "case-lease-prop-oak", kind: "lease-review", holdReason: "Read-only dates. No statutory action." },
  { id: "case-insp-prop-oak", kind: "inspection-prep", holdReason: "Checklist and draft wording. No statutory action." },
  { id: "case-inbound-prop-oak", kind: "inbound-triage", holdReason: "Declared inbound triage. Not a clock run." },
];

export function ensureDemoBreadth(book: DeskFileV3, now: number): DeskFileV3 {
  if (book.mode !== "demo") return book;
  if (!book.agency.name) book.agency.name = "Demo agency";
  if (!book.agency.jurisdictions.length) book.agency.jurisdictions = ["ACT"];
  if (!book.properties.some((property) => property.id === "prop-oak")) return book;

  const historicId = "ten-historic-prop-oak";
  if (!book.tenancies.some((tenancy) => tenancy.id === historicId)) {
    book.tenancies.push({
      id: historicId,
      propertyId: "prop-oak",
      status: "closed",
      weeklyRentCents: 58_000,
      closedAt: now - 90 * 86_400_000,
    });
  }

  if (!book.contacts.some((contact) => contact.id === "ctc-owner-prop-oak")) {
    book.contacts.push({
      id: "ctc-owner-prop-oak",
      role: "owner",
      name: "Pat Chen",
      phone: "0411 000 111",
      propertyId: "prop-oak",
      safeguards: { ...quietSafeguards, preferredChannel: "email" },
    });
  }

  if (!book.contacts.some((contact) => contact.id === "ctc-tradie-prop-oak")) {
    book.contacts.push({
      id: "ctc-tradie-prop-oak",
      role: "tradie",
      name: "River Plumbing",
      phone: "02 6100 2000",
      propertyId: "prop-oak",
      safeguards: { ...quietSafeguards, preferredChannel: "sms" },
    });
  }

  const currentTenancy = tenancyIdFromProperty("prop-oak");
  const tenantId = tenantContactIdFromProperty("prop-oak");
  const tenant = book.contacts.find((contact) => contact.id === tenantId);
  if (tenant && !tenant.tenancyId) tenant.tenancyId = currentTenancy;

  if (book.cases.some((item) => item.inbound)) {
    book.cases = book.cases.filter((item) => item.id !== "case-maint-prop-oak" && item.id !== "case-inbound-prop-oak");
  }

  for (const extra of EXTRA_CASES) {
    if (book.cases.some((item) => item.inbound) && (extra.kind === "maintenance-intake" || extra.kind === "inbound-triage")) continue;
    if (book.cases.some((item) => item.id === extra.id) || book.importIssues.some((issue) => issue.id === extra.id)) {
      continue;
    }
    book.cases.push({
      id: extra.id,
      kind: extra.kind,
      state: "held",
      propertyId: "prop-oak",
      tenancyId: currentTenancy,
      holdReason: extra.holdReason,
      createdAt: now,
      updatedAt: now,
    });
  }
  return book;
}
