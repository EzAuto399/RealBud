// Fictional setup stages for component tests: stage 0 (not linked) to ready,
// then the degraded states. Built with the real `setupState`, never hand-made gates.
import type { AustinChecklistItem, AustinPackView } from "@shared/austin-pack";
import { NO_OFFICE_FACTS, setupState, type OfficeLinkFacts, type SetupSequenceInput, type SetupState } from "@/lib/setup-sequence";

export type FixtureStage = 0 | 1 | 2 | 3 | 4 | "ready" | "revoked" | "aiLimit" | "gmailLost" | "reiSignedOut";

const plan = { reads: "Fictional source", waitsFor: "Nothing", notifies: "You", approval: "Before anything is sent" };
const pack = (installed: boolean, done: Partial<Record<AustinChecklistItem["id"], boolean>>): AustinPackView => ({
  pack: { id: "fictional-pack", revision: 1, title: "Fictional Accounts pack" },
  timeZone: "Australia/Brisbane",
  timeZoneFromOffice: true,
  installed: installed ? { revision: 1, at: 1, loopIds: ["weekly-bills", "rei-supplier-check"] } : null,
  loops: [
    { loopId: "weekly-bills", owner: "Accounts", plan, needs: ["gmail"] },
    { loopId: "rei-supplier-check", owner: "Accounts", plan, needs: ["rei", "suppliers"] },
  ],
  rules: [],
  checklist: [
    { id: "gmail", label: "Gmail connected", done: Boolean(done.gmail), detail: "Connect the office Gmail in Connected apps." },
    { id: "rei", label: "Signed in to REI Cloud once", done: Boolean(done.rei), detail: "Sign in on REI’s own page." },
    { id: "suppliers", label: "REI supplier list saved", done: Boolean(done.suppliers), detail: "In Bills, Maintenance checks, choose Refresh from REI to save the supplier list." },
    { id: "workflows", label: "Each workflow reviewed and switched on", done: Boolean(done.workflows), detail: "0 of 2 on." },
  ],
});
const loops = (on: boolean) => ({
  read: "ready" as const,
  loops: [
    { id: "weekly-bills", name: "Weekly bills", available: true, enabled: on, nextRunAt: on ? 1_800_000_000_000 : null },
    { id: "rei-supplier-check", name: "REI supplier check", available: true, enabled: on, nextRunAt: on ? 1_800_000_000_000 : null },
  ],
});
const linked: OfficeLinkFacts = { ...NO_OFFICE_FACTS, link: "linked" };
const budReady = { ready: true, working: false, detail: null };
const signedIn = { state: "signed_in" as const, used: true, signingIn: false };

export function stageInput(stage: FixtureStage): SetupSequenceInput {
  const ready: SetupSequenceInput = {
    agencySetup: "unavailable", websiteLink: "linked", office: linked, bud: budReady, gmailReady: "office", rei: signedIn,
    austinPack: pack(true, { gmail: true, rei: true, suppliers: true, workflows: true }), schedule: loops(true),
  };
  switch (stage) {
    case 0: return { agencySetup: "unavailable", websiteLink: "not-linked", office: { ...NO_OFFICE_FACTS, link: "not-linked" }, bud: { ready: false, working: false, detail: null }, austinPack: pack(false, {}), schedule: loops(false) };
    case 1: return { ...ready, bud: { ready: false, working: true, detail: null, step: 2, total: 4 }, gmailReady: null, rei: null, austinPack: pack(false, {}), schedule: loops(false) };
    case 2: return { ...ready, gmailReady: null, rei: null, austinPack: pack(false, {}), schedule: loops(false) };
    case 3: return { ...ready, rei: { state: "needed", used: false, signingIn: false }, austinPack: pack(true, { gmail: true }), schedule: loops(false) };
    case 4: return { ...ready, austinPack: pack(true, { gmail: true, rei: true, suppliers: true }), schedule: loops(false) };
    case "ready": return ready;
    case "revoked": return { ...ready, websiteLink: "not-linked", office: { ...NO_OFFICE_FACTS, link: "not-linked", revoked: true } };
    case "aiLimit": return { ...ready, office: { ...linked, usage: { state: "ready", usage: { remainingNanoAud: "0" } } as OfficeLinkFacts["usage"] } };
    case "gmailLost": return { ...ready, gmailDegraded: true };
    case "reiSignedOut": return { ...ready, rei: { state: "needed", used: true, signingIn: false, waiting: [{ loopId: "rei-supplier-check" }] } };
  }
}

export const stageState = (stage: FixtureStage): SetupState => setupState(stageInput(stage));
