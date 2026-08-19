// Product fleet is the pinned Hermes worker only. Other CLIs stay on disk
// for tests; they are not agents in RealBud. Models attach on `hermes -p property`.
import type { AnyProviderDriver } from "../contracts.ts";
import { HermesAgentDriver } from "./acp/hermes.ts";

export const BUILT_IN_DRIVERS: readonly AnyProviderDriver[] = [HermesAgentDriver];
