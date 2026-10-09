import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { officeDrafts, type OfficeDraftContext } from '@/lib/office-draft-journal';

import { OfficeCard } from "./OfficeCard";

// The card reads the book it is handed rather than the store; the mock keeps the
// house component-test pattern if anything in its tree ever reaches for it.
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

const hostZone = "America/New_York";
const context: OfficeDraftContext = { workspaceId: 'fictional-office-workspace', companyId: null, memberId: null, sessionVersion: 0 };
afterEach(() => { const entry = officeDrafts.read(context); if (entry) officeDrafts.discard(context, entry.sequence); });
let original: string | undefined;

beforeAll(() => {
  // A machine already sitting in the old fallback zone would hide the bug, so
  // pin this computer's zone somewhere that fixture never is.
  original = process.env.TZ;
  process.env.TZ = hostZone;
});

afterAll(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

const render = (timezone: string | null) =>
  renderToStaticMarkup(
    createElement(OfficeCard, {
      agencyName: "Harbour PM",
      timezone,
      jurisdictions: ["NSW"],
      revision: 3,
      draftContext: context,
      onSave: () => Promise.resolve(),
      onReload: () => Promise.resolve(),
    }),
  );

describe("book timezone", () => {
  it("shows a recorded zone as the book's own setting", () => {
    const html = render("Australia/Brisbane");
    expect(html).toContain("Book timezone: Australia/Brisbane");
    expect(html).not.toContain("not recorded yet");
  });

  it("never presents a fixture zone as the book's setting when none is recorded", () => {
    const html = render(null);
    expect(html).toContain("Book timezone: not recorded yet.");
    expect(html).toContain(`this computer’s timezone (${hostZone})`);
    expect(html).not.toContain("Australia/Sydney");
  });

  it("keeps the form's accessible names while the zone is unrecorded", () => {
    const html = render(null);
    expect(html).toContain('aria-label="Agency name"');
    expect(html).toContain('aria-label="Office contact for RealBud"');
  });
});

describe('retained office draft rendering', () => {
  const card = (draftContext: OfficeDraftContext | null = context, revision = 3, identityError = '') => renderToStaticMarkup(createElement(OfficeCard, {
    agencyName: 'Saved office', timezone: null, jurisdictions: ['NSW'], revision, draftContext, identityError,
    onSave: vi.fn(), onReload: async () => {}, onRetryIdentity: vi.fn(),
  }));
  it('renders retained typing on a new card without presenting it as saved', () => {
    officeDrafts.write(context, 3, { name: 'Typed office', office: { pmUser: 'Typed contact' } });
    const html = card();
    expect(html).toContain('value="Typed office"'); expect(html).toContain('value="Typed contact"');
    expect(html).toContain('Unsaved changes'); expect(html).not.toContain('Changes saved');
  });
  it('keeps changed-revision typing visible with Save held and reload/discard recovery', () => {
    officeDrafts.write(context, 3, { name: 'Typed office' }); const html = card(context, 4);
    expect(html).toContain('value="Typed office"');
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Save changes<\/button>/);
    expect(html).toContain('Discard edits and reload saved settings');
  });
  it('shows identity-read recovery without downgrading the original retained draft to local-only', () => {
    officeDrafts.write(context, 3, { name: 'Typed office' }); const html = card(context, 3, 'Office identity could not be checked.');
    expect(html).toContain('value="Typed office"'); expect(html).toContain('<fieldset disabled=""');
    expect(html).toContain('Check office identity again'); expect(officeDrafts.read(context)?.changes.name).toBe('Typed office');
  });
  it('never renders a different workspace or member session’s typing', () => {
    officeDrafts.write(context, 3, { name: 'Private predecessor typing' });
    expect(card({ ...context, workspaceId: 'other' })).not.toContain('Private predecessor typing');
    expect(card({ ...context, sessionVersion: 1 })).not.toContain('Private predecessor typing');
  });
  it('keeps an unadmitted save reply held when the same card is reopened', () => {
    const entry = officeDrafts.write(context, 3, { name: 'Original typing' });
    officeDrafts.beginSave(context, 3, entry.sequence); officeDrafts.finishSave(context, entry.sequence, false, true);
    const html = card(); expect(html).toContain('value="Original typing"');
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Save changes<\/button>/);
    expect(html).toContain('do not repeat the save'); expect(html).toContain('Discard edits and reload saved settings');
  });
  it('offers ended-session recovery without exposing retained predecessor wording', () => {
    officeDrafts.write(context, 3, { name: 'Private predecessor text' });
    const html = card({ ...context, sessionVersion: 1 });
    expect(html).not.toContain('Private predecessor text'); expect(html).toContain('1 unsaved office draft is kept from ended sign-in sessions');
    expect(html).toContain('Review clearing ended-session office drafts'); expect(html).not.toContain('Permanently clear');
  });
});
