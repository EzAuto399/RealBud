import type {
  BookMode,
  CheckResult,
  Draft,
  Escalation,
  HandsSource,
  LedgerFacts,
  Observation,
  PortalCapability,
  PortalRecipe,
  Property,
  PropertyPortalBinding,
  SourceIdentity,
  WorkItem,
} from "./contracts.ts";

export interface DeskFileV2 {
  version: 2;
  revision: number;
  mode: BookMode;
  timezone: string;
  retentionDays: number | null;
  properties: Property[];
  ledger: LedgerFacts[];
  drafts: Draft[];
  escalations: Escalation[];
  workItems: WorkItem[];
  lastRunAt: number | null;
  results: CheckResult[];
  hands: HandsSource;
  handsDetail: string | null;
  sources: SourceIdentity[];
  observations: Observation[];
  portalBindings: PropertyPortalBinding[];
  recipes: PortalRecipe[];
  capabilities: PortalCapability[];
}
