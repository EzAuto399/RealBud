/// <reference types="vite/client" />

/** Only explicit fixture builds are previews; ordinary local development can
 * use a real workspace and must not be mistaken for fictional data. */
export const DESIGN_PREVIEW_REASON: string | null = import.meta.env.MODE === 'design-preview'
  ? 'This design preview uses example data. Live Bud, app sign-in and computer access are available in the RealBud app.'
  : null;
