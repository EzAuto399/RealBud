import type { BrowserStatus } from "../shared/browser.ts";
import type { BrowserActionClass } from "../shared/browser-task.ts";

export type BrowserJson = Record<string, unknown>;
export type BrowserHelpOutcome = "completed" | "continued" | "cancelled" | "timed_out" | "disabled" | "unknown";
export interface BrowserSessionTab { id: number; url: string; title: string; browserId: string; claimed: boolean }
export interface BrowserSessionObservation { tabId: number; text: string; truncated: boolean }
export type BrowserSessionAction =
  | { kind: "navigate"; tabId: number; url: string }
  | { kind: "fill"; tabId: number; ref: string; value: string }
  | { kind: "click"; tabId: number; ref: string }
  | { kind: "press"; tabId: number; ref: string; key: string }
  | { kind: "select"; tabId: number; ref: string; values: string[] }
  | { kind: "download"; tabId: number; ref: string; path: string }
  | { kind: "upload"; tabId: number; ref: string; path: string };

/** Host-owned session boundary. No CLI, endpoint, profile path or credentials
 * are available through the worker's MCP surface. */
export interface BrowserSessionRuntime {
  readonly root: string;
  readonly supportedActions: readonly BrowserActionClass[];
  readonly readOnly: boolean;
  status(): Promise<BrowserStatus>;
  acquire(owner: string): Promise<string>;
  isOwner(owner: string): boolean;
  checkSession(owner: string): Promise<void>;
  listTabs(owner: string, signal?: AbortSignal): Promise<BrowserSessionTab[]>;
  claimTab(owner: string, tabId: number, signal?: AbortSignal): Promise<void>;
  /** `scroll`: a lazy grid's scroll container from the portal's declared controls (never a model); the read loads every row. */
  observeTab(owner: string, tabId: number, signal?: AbortSignal, scroll?: string): Promise<BrowserSessionObservation>;
  perform(owner: string, action: BrowserSessionAction, signal?: AbortSignal): Promise<BrowserJson>;
  requestHelp(owner: string, input: { tabId: number; title: string; prompt: string }, signal?: AbortSignal): Promise<BrowserHelpOutcome>;
  release(owner: string): Promise<void>;
}
