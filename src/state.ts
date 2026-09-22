import type { ExecutionHandle, WorkGraph } from "./contracts.js";

export type WorkStatus =
  "pending" | "running" | "waiting" | "done" | "failed" | "cancelled";
export type WorkStep = "execute" | "validate" | "approve-asset" | "deliver";

export interface WorkState {
  status: WorkStatus;
  step?: WorkStep;
  attempt?: string;
  waitingReason?: string;
  execution?: ExecutionHandle;
  treeSha?: string;
  pullRequest?: number;
  error?: string;
}

export interface FactoryState {
  schemaVersion: 1;
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  baseSha: string;
  graph: WorkGraph;
  issueByItemId: Record<string, number>;
  work: Record<string, WorkState>;
  integratedSha?: string;
  finalValidation?: { treeSha: string; passed: boolean; detail?: string };
}
