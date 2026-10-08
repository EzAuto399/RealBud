// What a staff member asks their office owner when only the owner can fix a
// step. Copied to the clipboard, never sent: the person passes it on however
// they like. Each says what to do and where.
export const OWNER_COMPUTERS_URL = "https://realbud.app/account/installations";

export const OWNER_REQUEST = {
  linkCode: `Hi, could you send me a RealBud link code for my computer? Create one at ${OWNER_COMPUTERS_URL} with Pair a new computer, then send me the code. Thanks.`,
  freePlace: `Hi, RealBud says our office already has its full number of computers. Could you disconnect one we no longer use at ${OWNER_COMPUTERS_URL}, so I can link mine? Thanks.`,
  sharedGmail: `Hi, could you allow my computer to use the office shared Gmail in RealBud? Open ${OWNER_COMPUTERS_URL}, choose Gmail for this office, then allow my computer. Thanks.`,
  bankFeed: "Hi, could you connect the office bank feed in RealBud? On your computer, open Workspace → Connected apps → Bank feed and choose Connect bank feed. Until then I can choose the bank CSV in the bank reference review. Thanks.",
  removeComputer: `Hi, could you remove my computer in RealBud under Account → Computers at ${OWNER_COMPUTERS_URL}? Then I can link it again. Thanks.`,
} as const;

export type OwnerRequestKind = keyof typeof OWNER_REQUEST;
