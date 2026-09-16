import type { SharedWorkActivity, SharedWorkItem, SharedWorkPerson, SharedWorkPurpose, SharedWorkState } from "@shared/company-work";

const MAX_ID = 128;
const MAX_NAME = 120;
const MAX_TITLE = 160;
const MAX_TEXT = 4_000;
const MAX_REVISION = 64;
const MAX_PEOPLE = 100;
const MAX_ITEMS = 10;
const PURPOSES = new Set(["share-result", "request-review", "handoff"]);
const STATES = new Set(["open", "accepted", "responded", "closed"]);

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number, allowEmpty = false) =>
  typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0) && !value.includes("\0") ? value : null;
function fail(): never {
  throw new Error("The company service returned an incomplete response. Check company status before trying again.");
};

function parsePerson(value: unknown): SharedWorkPerson {
  if (!object(value)) fail();
  const id = text(value.id, MAX_ID);
  const displayName = text(value.displayName, MAX_NAME);
  if (!id || !displayName) fail();
  return { id, displayName };
}

function parsePeople(value: unknown): SharedWorkPerson[] {
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) fail();
  return value.map(parsePerson);
}

function parseItem(value: unknown): SharedWorkItem {
  if (!object(value)) fail();
  const id = text(value.id, MAX_ID);
  const scopeId = text(value.scopeId, MAX_ID);
  const revision = text(value.revision, MAX_REVISION);
  const title = text(value.title, MAX_TITLE);
  const summary = text(value.summary, MAX_TEXT);
  const response = text(value.response, MAX_TEXT, true);
  const purpose = text(value.purpose, 32);
  const state = text(value.state, 32);
  const updatedAt = text(value.updatedAt, 64);
  if (!id || !scopeId || !revision || !title || !summary || response === null || !purpose || !state || !updatedAt) fail();
  if (!/^[1-9][0-9]{0,18}$/.test(revision) || !PURPOSES.has(purpose) || !STATES.has(state) || !Number.isFinite(Date.parse(updatedAt))) fail();
  // Older company hosts omit action metadata. Keep their records readable,
  // but never infer write authority merely from being in the audience.
  const actions = value.actions === undefined ? { respond: false, close: false } : value.actions;
  if (!object(actions) || typeof actions.respond !== 'boolean' || typeof actions.close !== 'boolean') fail();
  const extra: Partial<SharedWorkItem> = {};
  for (const name of ['accept', 'reassign', 'addRecipient'] as const) {
    if (actions[name] !== undefined && typeof actions[name] !== 'boolean') fail();
  }
  if (value.acceptedBy !== undefined) extra.acceptedBy = value.acceptedBy === null ? null : parsePerson(value.acceptedBy);
  if (value.ownerAvailable !== undefined) {
    if (typeof value.ownerAvailable !== 'boolean') fail();
    extra.ownerAvailable = value.ownerAvailable;
  }
  if (value.evidence !== undefined) {
    if (value.evidence === null) extra.evidence = null;
    else {
      const evidence = value.evidence;
      if (!object(evidence)) fail();
      const label = text(evidence.label, 160), sourceRef = text(evidence.sourceRef, 500), sourceVersion = text(evidence.sourceVersion, 120);
      const excerpt = text(evidence.text, 8000), sha256 = text(evidence.sha256, 64);
      if (!label || !sourceRef || !sourceVersion || !excerpt || !sha256 || !/^[a-f0-9]{64}$/.test(sha256)) fail();
      extra.evidence = { label, sourceRef, sourceVersion, text: excerpt, sha256 };
    }
  }
  return {
    id,
    scopeId,
    revision,
    title,
    summary,
    purpose: purpose as SharedWorkPurpose,
    state: state as SharedWorkState,
    owner: parsePerson(value.owner),
    assignee: value.assignee === null ? null : parsePerson(value.assignee),
    audience: parsePeople(value.audience),
    response,
    updatedBy: parsePerson(value.updatedBy),
    updatedAt,
    ...extra,
    actions: { respond: actions.respond, close: actions.close,
      ...(actions.accept === undefined ? {} : { accept: actions.accept as boolean }),
      ...(actions.reassign === undefined ? {} : { reassign: actions.reassign as boolean }),
      ...(actions.addRecipient === undefined ? {} : { addRecipient: actions.addRecipient as boolean }) },
  };
}

export function parseWorkMembers(value: unknown): { members: SharedWorkPerson[] } {
  if (!object(value) || !Array.isArray(value.members) || value.members.length > MAX_PEOPLE) fail();
  return { members: value.members.map(parsePerson) };
}

export function parseSharedWorkList(value: unknown): { items: SharedWorkItem[] } {
  if (!object(value) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) fail();
  return { items: value.items.map(parseItem) };
}

export function parseSharedWorkItemResponse(value: unknown): { item: SharedWorkItem } {
  if (!object(value)) fail();
  return { item: parseItem(value.item) };
}

export function parseSharedWorkHistory(value: unknown): { events: SharedWorkActivity[]; hasMore: boolean } {
  if (!object(value) || !Array.isArray(value.events) || value.events.length > 20 || typeof value.hasMore !== 'boolean') fail();
  return { hasMore: value.hasMore, events: value.events.map((event): SharedWorkActivity => {
    if (!object(event)) fail();
    const revision = text(event.revision, MAX_REVISION), action = text(event.action, 32), at = text(event.at, 64), response = text(event.response, MAX_TEXT, true);
    if (!revision || !/^[1-9][0-9]{0,18}$/.test(revision) || !action || !['shared','accepted','reassigned','responded','closed'].includes(action) ||
        !at || !Number.isFinite(Date.parse(at)) || response === null) fail();
    return { revision, action: action as SharedWorkActivity['action'], at, response, actor: parsePerson(event.actor),
      assignee: event.assignee === null ? null : parsePerson(event.assignee) };
  }) };
}
