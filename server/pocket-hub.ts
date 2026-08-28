// RealBud-owned multi-channel gateway. The adapters only normalize transport
// events; every request and decision still goes through the one canonical Ask
// thread and its authoritative action broker.
import { join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { PocketGateway, type PocketGatewayConfig, type PocketStatus } from "./pocket-gateway.ts";
import type { PocketConnectionState, PocketHandlers } from "./pocket-shared.ts";
import {
  WhatsAppCloudGateway,
  type WhatsAppCloudConfig,
  type WhatsAppCloudStatus,
} from "./pocket-whatsapp-cloud.ts";

const MAX_QUEUED_POCKET_TURNS = 4;
const MAX_QUEUED_POCKET_DECISIONS = 8;

export interface PocketHubStatus {
  provider: "multi-channel";
  configured: boolean;
  enabled: boolean;
  pilotReady: boolean;
  state: PocketConnectionState;
  detail: string;
  connectedCount: number;
  channels: {
    telegram: PocketStatus;
    whatsappCloud: WhatsAppCloudStatus;
  };
}

export interface PocketHubConfig {
  pilotReady: boolean;
  telegram: Omit<PocketGatewayConfig, "pilotReady">;
  whatsappCloud: Omit<WhatsAppCloudConfig, "pilotReady">;
}

export class PocketHub {
  private readonly telegram: PocketGateway;
  private readonly whatsappCloud: WhatsAppCloudGateway;
  private readonly onStatusChange?: (status: PocketHubStatus) => void;
  private pilotReady = false;
  private acceptingTurns = false;
  private generation = 0;
  private queuedTurns = 0;
  private queuedDecisions = 0;
  private turnQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    handlers: PocketHandlers;
    stateDir?: string;
    telegram?: {
      fetchImpl?: typeof fetch;
      apiBase?: string;
      autoPoll?: boolean;
    };
    whatsappCloud?: {
      fetchImpl?: typeof fetch;
      graphBase?: string;
      listenPort?: number;
    };
    now?: () => number;
    onStatusChange?: (status: PocketHubStatus) => void;
  }) {
    const stateDir = options.stateDir ?? DATA_DIR;
    this.onStatusChange = options.onStatusChange;
    const changed = () => this.onStatusChange?.(this.status());
    const channelHandlers: PocketHandlers = {
      ...options.handlers,
      onText: (text) => this.enqueueWork("turn", () => options.handlers.onText(text)),
      onDecision: (messageId, decision) => this.enqueueWork(
        "decision",
        () => options.handlers.onDecision(messageId, decision),
      ),
    };
    this.telegram = new PocketGateway({
      handlers: channelHandlers,
      // Keep the shipped Telegram ledger path so an upgrade cannot forget a
      // claimed update and replay it under the new hub topology.
      stateFile: join(stateDir, "pocket-state.json"),
      fetchImpl: options.telegram?.fetchImpl,
      apiBase: options.telegram?.apiBase,
      autoPoll: options.telegram?.autoPoll,
      now: options.now,
      onStatusChange: changed,
    });
    this.whatsappCloud = new WhatsAppCloudGateway({
      handlers: channelHandlers,
      stateFile: join(stateDir, "pocket-whatsapp-state.json"),
      fetchImpl: options.whatsappCloud?.fetchImpl,
      graphBase: options.whatsappCloud?.graphBase,
      listenPort: options.whatsappCloud?.listenPort,
      now: options.now,
      onStatusChange: changed,
    });
  }

  private async enqueueWork<T>(kind: "turn" | "decision", run: () => Promise<T>): Promise<T> {
    if (!this.acceptingTurns) throw new Error("Pocket is reconnecting. This request was not started; try again when the channel is ready.");
    const generation = this.generation;
    if (kind === "turn" && this.queuedTurns >= MAX_QUEUED_POCKET_TURNS) {
      throw new Error("Bud already has several Pocket requests waiting. This request was not queued; try again after Ask settles.");
    }
    if (kind === "decision" && this.queuedDecisions >= MAX_QUEUED_POCKET_DECISIONS) {
      throw new Error("Several Pocket decisions are already waiting. This decision was not applied; review it in RealBud.");
    }
    if (kind === "turn") this.queuedTurns += 1;
    else this.queuedDecisions += 1;
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.turnQueue = this.turnQueue
      .then(async () => {
        if (!this.acceptingTurns || generation !== this.generation) {
          throw new Error("Pocket stopped before this request began. It was not replayed.");
        }
        resolveResult(await run());
      })
      .catch((error) => rejectResult(error))
      .finally(() => {
        if (kind === "turn") this.queuedTurns = Math.max(0, this.queuedTurns - 1);
        else this.queuedDecisions = Math.max(0, this.queuedDecisions - 1);
      });
    return await result;
  }

  status(): PocketHubStatus {
    const telegram = this.telegram.status();
    const whatsappCloud = this.whatsappCloud.status();
    const channels = [telegram, whatsappCloud];
    const enabled = channels.filter((channel) => channel.enabled);
    const connected = enabled.filter((channel) => channel.state === "ready");
    let state: PocketConnectionState;
    let detail: string;
    if (!this.pilotReady) {
      state = "pilot-gated";
      detail = "Name the pilot agency and PM before Pocket can connect.";
    } else if (!enabled.length) {
      state = "off";
      detail = channels.some((channel) => channel.configured)
        ? "Pocket channels are configured but off."
        : "Connect a private PM messaging channel.";
    } else if (enabled.some((channel) => channel.state === "attention")) {
      state = "attention";
      detail = "A Pocket channel needs attention. Open its setup below for the exact recovery step.";
    } else if (enabled.some((channel) => channel.state === "connecting")) {
      state = "connecting";
      detail = "Checking the PM's Pocket channels…";
    } else if (enabled.some((channel) => channel.state === "setup-required")) {
      state = connected.length ? "attention" : "setup-required";
      detail = connected.length
        ? `${connected.length} channel connected; another channel still needs setup.`
        : "Finish the enabled channel setup before using Pocket.";
    } else if (connected.length) {
      state = "ready";
      detail = `${connected.length} private PM channel${connected.length === 1 ? " is" : "s are"} connected to the same Ask thread.`;
    } else {
      state = "off";
      detail = "Pocket is off.";
    }
    return {
      provider: "multi-channel",
      configured: channels.some((channel) => channel.configured),
      enabled: enabled.length > 0,
      pilotReady: this.pilotReady,
      state,
      detail,
      connectedCount: connected.length,
      channels: { telegram, whatsappCloud },
    };
  }

  async configure(input: PocketHubConfig): Promise<PocketHubStatus> {
    this.acceptingTurns = false;
    this.generation += 1;
    // Drain the previous Telegram poll before exposing new credentials or
    // channel state. This prevents an in-flight request from replying through
    // a newly configured adapter.
    await Promise.all([this.telegram.stop(), this.whatsappCloud.stop()]);
    this.pilotReady = input.pilotReady;
    // Each adapter starts receiving as part of configure(). Enable the shared
    // Ask queue first so a message arriving on that first poll/webhook cannot
    // be claimed and then rejected as a reconnect race.
    this.acceptingTurns = input.pilotReady;
    try {
      await Promise.all([
        this.telegram.configure({ ...input.telegram, pilotReady: input.pilotReady }),
        this.whatsappCloud.configure({ ...input.whatsappCloud, pilotReady: input.pilotReady }),
      ]);
    } catch (error) {
      this.acceptingTurns = false;
      await Promise.all([this.telegram.stop(), this.whatsappCloud.stop()]);
      throw error;
    }
    const status = this.status();
    this.onStatusChange?.(status);
    return status;
  }

  async stop(): Promise<void> {
    this.acceptingTurns = false;
    this.generation += 1;
    await Promise.all([this.telegram.stop(), this.whatsappCloud.stop()]);
  }
}
