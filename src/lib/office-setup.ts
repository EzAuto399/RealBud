// First-run walkthrough for You → This office.
//
// The office contract is eight fields (`officeTicks` in shared/office.ts). Only
// two of them change what the desk can do for a named office: who the agency
// is, and where the properties are. The rest are optional or technical in the
// form itself, so treating all eight as required would invent an obstacle
// rather than remove one.
//
// This module deliberately does not define a second list of fields. It labels
// and groups the single contract that `officeTicks` already owns, so the
// checklist cannot drift from the form that satisfies it. The group ids below
// are the scroll targets in src/components/you/OfficeCard.tsx.

import { agencyIsNamed, officeTicks, type Office, type OfficeTickId } from "../../shared/office";

export { agencyIsNamed };
export type { Office };

/** The card that holds every one of these fields. */
export const OFFICE_CARD_ID = "you-office";

interface OfficeGroup {
  /** DOM id of the form group, used as the scroll target. */
  id: string;
  label: string;
}

/** Form groups as they actually appear in OfficeCard. */
const GROUPS: Record<string, OfficeGroup> = {
  identity: { id: "office-group-identity", label: "Agency name and states" },
  software: { id: "office-group-software", label: "Software and office contact" },
  csv: { id: "office-group-csv", label: "CSV handover notes" },
  portal: { id: "office-group-portal", label: "Assisted portal setup" },
};

const GROUP_OF: Record<OfficeTickId, string> = {
  "agency-pm": "identity",
  "pms-brand": "software",
  exporter: "csv",
  cadence: "csv",
  identity: "csv",
  "office-os": "portal",
  jurisdictions: "identity",
  "vendor-test": "portal",
};

/** Ticks that change what the desk can do. These are the walkthrough. */
const ESSENTIAL: readonly OfficeTickId[] = ["agency-pm", "jurisdictions"];

/**
 * `office-os` is recorded but never asked for in the form — the app derives the
 * platform it is running on. Nagging for it would send someone to look for a
 * control that does not exist, so it never appears in the walkthrough.
 */
const NEVER_ASKED: readonly OfficeTickId[] = ["office-os"];

export interface OfficeSetupItem {
  id: OfficeTickId;
  /** The contract's own wording, so the checklist reads like the form. */
  label: string;
  done: boolean;
  /** Form group this field lives in, as a scroll target. */
  groupId: string;
  groupLabel: string;
}

export interface OfficeSetup {
  complete: boolean;
  doneCount: number;
  total: number;
  /** Outstanding essentials, in contract order. Empty means nothing blocks. */
  remaining: OfficeSetupItem[];
  essential: OfficeSetupItem[];
  /** Outstanding optional fields, offered but never demanded. */
  optional: OfficeSetupItem[];
  /** True when nothing on the desk is named yet — a genuinely new office. */
  fresh: boolean;
}

/**
 * The walkthrough state for one office. Pure: same book in, same answer out.
 *
 * `complete` deliberately means "every essential is done", not "all eight ticks
 * are done". An office that has named itself and placed its properties has a
 * working desk; the CSV and portal details belong to the job that needs them,
 * and demanding a count of eight would misreport that office as unfinished
 * forever.
 */
export function officeSetup(input: {
  agencyName: string;
  jurisdictions: readonly string[];
  office: Office;
}): OfficeSetup {
  const items: OfficeSetupItem[] = officeTicks(input).map((tick) => {
    const group = GROUPS[GROUP_OF[tick.id]]!;
    return {
      id: tick.id,
      label: tick.label,
      done: tick.done,
      groupId: group.id,
      groupLabel: group.label,
    };
  });

  const asked = items.filter((item) => !NEVER_ASKED.includes(item.id));
  const essential = asked.filter((item) => ESSENTIAL.includes(item.id));
  const remaining = essential.filter((item) => !item.done);
  const optional = asked.filter((item) => !ESSENTIAL.includes(item.id) && !item.done);

  return {
    complete: remaining.length === 0,
    doneCount: asked.filter((item) => item.done).length,
    total: asked.length,
    remaining,
    essential,
    optional,
    fresh: !agencyIsNamed(input.agencyName) && input.office.pmUser.trim().length === 0,
  };
}

/** One line naming what is left, or null when the desk is ready. */
export function officeSetupHeadline(setup: OfficeSetup): string | null {
  if (setup.complete) return null;
  const [first] = setup.remaining;
  if (!first) return null;
  if (setup.remaining.length === 1) return `One thing left: ${first.label.toLowerCase()}.`;
  return `${setup.remaining.length} things left before the desk is set up for your office.`;
}

/** Hash link that lands on the form group for one item. */
export function officeSetupHref(item: OfficeSetupItem): string {
  return `#${item.groupId}`;
}
