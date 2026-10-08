// Where people reach RealBud support, said the same way everywhere.
// Mirrors SUPPORT_EMAIL in the website (realbud.app lib/site.ts).
export const SUPPORT_EMAIL = "hello@realbud.app";

const WHERE = `RealBud support at ${SUPPORT_EMAIL} with a support file (Workspace → Settings & help → Save support file)`;
/** Starts a sentence: "Contact RealBud support at … before trying again." */
export const CONTACT_SUPPORT = `Contact ${WHERE}`;
/** Inside a sentence: "Try again, or contact RealBud support at …." */
export const CONTACT_SUPPORT_INLINE = `contact ${WHERE}`;
