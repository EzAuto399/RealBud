export function startCuaControl(operations: {
  release: () => Promise<void>;
  verify: (binding: { version: 1; pid: number; windowId: number; origin: string; accountMarker: string; readyMarker: string }, requestId: string) => Promise<boolean>;
  restore?: () => Promise<void>;
}): Promise<{ env: { REALBUD_CUA_CONTROL_URL: string; REALBUD_CUA_CONTROL_TOKEN: string }; close: () => Promise<void> }>;
