import type { ExecutionHandle, WorkGraph } from "./contracts.js";
import type { ValidationEvidence } from "./validation.js";

export type WorkStatus =
  "pending" | "running" | "waiting" | "done" | "failed" | "cancelled";
export type WorkStep = "execute" | "validate" | "approve-asset" | "deliver";

export interface WorkState {
  status: WorkStatus;
  step?: WorkStep;
  attempt?: string;
  waitingReason?: string;
  execution?: ExecutionHandle;
  baseSha?: string;
  changeRef?: string;
  treeSha?: string;
  validation?: ValidationEvidence;
  pullRequest?: number;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface FactoryState {
  schemaVersion: 1;
  repository: string;
  objective: number;
  runId: string;
  configDigest: string;
  baseSha: string;
  graph: WorkGraph;
  objectiveCommands?: string[];
  issueByItemId: Record<string, number>;
  work: Record<string, WorkState>;
  integratedSha?: string;
  finalValidation?: ValidationEvidence & { passed: boolean; detail?: string };
  cancelRequested?: boolean;
  cancelledAt?: string;
  error?: string;
}
