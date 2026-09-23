import type {
  CapturedAssetSet,
  ExecutionHandle,
  WorkGraph,
} from "./contracts.js";
import type { ValidationEvidence } from "./validation.js";

export type WorkStatus =
  | "pending"
  | "running"
  | "published"
  | "waiting"
  | "done"
  | "failed"
  | "cancelled";
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
  assets?: CapturedAssetSet[];
  selectedAssetSet?: string;
  selectionDigest?: string;
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
  stackNumbers?: Record<string, number>;
  stackMerges?: Record<
    string,
    { topPullRequest: number; expectedHeadSha: string; uuid: string }
  >;
  integratedSha?: string;
  finalValidation?: ValidationEvidence & { passed: boolean; detail?: string };
  cancelRequested?: boolean;
  cancelledAt?: string;
  error?: string;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} must be a nonempty string`);
  return value;
}

function sha(value: unknown, label: string, length = 40): string {
  const text = string(value, label);
  if (!new RegExp(`^[0-9a-f]{${length}}$`).test(text))
    throw new Error(
      `${label} must be a SHA-${length === 40 ? "1" : "256"} hex digest`,
    );
  return text;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((part) => typeof part === "string"))
    throw new Error(`${label} must be a string array`);
  return value;
}

const statuses = new Set<WorkStatus>([
  "pending",
  "running",
  "published",
  "waiting",
  "done",
  "failed",
  "cancelled",
]);
const steps = new Set<WorkStep>([
  "execute",
  "validate",
  "approve-asset",
  "deliver",
]);

/** Validate persisted state before it can control processes, Git, or GitHub. */
export function parseFactoryState(
  value: unknown,
  repository: string,
  objective: number,
): FactoryState {
  const state = record(value, "state");
  if (
    state.schemaVersion !== 1 ||
    state.repository !== repository ||
    state.objective !== objective
  )
    throw new Error(
      "schema version, repository, or Objective identity differs from the installation",
    );
  string(state.runId, "runId");
  sha(state.configDigest, "configDigest", 64);
  sha(state.baseSha, "baseSha");
  const graph = record(state.graph, "graph");
  if (
    graph.objective !== objective ||
    graph.baseSha !== state.baseSha ||
    !Array.isArray(graph.items) ||
    !graph.items.length
  )
    throw new Error("graph identity or items are invalid");
  const ids = new Set<string>();
  for (const [index, raw] of graph.items.entries()) {
    const item = record(raw, `graph.items[${index}]`);
    const id = string(item.id, "Work Item ID");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || ids.has(id))
      throw new Error(`invalid or duplicate Work Item ID ${id}`);
    ids.add(id);
    for (const key of ["title", "goal", "brief"])
      string(item[key], `${id}.${key}`);
    for (const key of [
      "acceptance",
      "nonGoals",
      "dependencies",
      "ownedPaths",
      "resources",
      "sourceAssets",
      "expectedOutputRoles",
      "requiredLfsRoles",
    ])
      strings(item[key], `${id}.${key}`);
    if (
      !Number.isSafeInteger(item.minimumAssetSets) ||
      Number(item.minimumAssetSets) < 0
    )
      throw new Error(`${id}.minimumAssetSets is invalid`);
    if (
      !Array.isArray(item.citations) ||
      !item.citations.every((citation) => typeof citation?.path === "string")
    )
      throw new Error(`${id}.citations are invalid`);
    if (
      !Array.isArray(item.validation) ||
      !item.validation.every(
        (check) =>
          typeof check?.command === "string" &&
          ["base-observed", "source-declared"].includes(check.provenance),
      )
    )
      throw new Error(`${id}.validation is invalid`);
  }
  for (const raw of graph.items) {
    const item = raw as Record<string, unknown>;
    if (
      !(item.dependencies as string[]).every(
        (id) => ids.has(id) && id !== item.id,
      )
    )
      throw new Error(`Work Item ${item.id} has an unknown dependency`);
  }
  const projected = record(state.issueByItemId, "issueByItemId");
  const work = record(state.work, "work");
  if (
    Object.keys(projected).length !== ids.size ||
    Object.keys(work).length !== ids.size
  )
    throw new Error(
      "graph, projected Issues, and work state have different keys",
    );
  for (const id of ids) {
    if (!Number.isSafeInteger(projected[id]) || Number(projected[id]) <= 0)
      throw new Error(`Work Item ${id} has no projected Issue identity`);
    const item = record(work[id], `work.${id}`);
    if (!statuses.has(item.status as WorkStatus))
      throw new Error(`Work Item ${id} has an invalid status`);
    if (item.step !== undefined && !steps.has(item.step as WorkStep))
      throw new Error(`Work Item ${id} has an invalid step`);
    for (const key of ["baseSha", "treeSha", "changeRef"])
      if (item[key] !== undefined) sha(item[key], `${id}.${key}`);
    if (item.status === "running" && (!item.step || !item.baseSha))
      throw new Error(`Running Work Item ${id} lacks step or base`);
    if (
      item.status === "waiting" &&
      (item.step !== "approve-asset" ||
        !Array.isArray(item.assets) ||
        !item.assets.length ||
        item.selectedAssetSet)
    )
      throw new Error(`Waiting Work Item ${id} lacks candidate assets`);
    if (
      item.status === "published" &&
      (!Number.isSafeInteger(item.pullRequest) || !item.changeRef)
    )
      throw new Error(`Published Work Item ${id} lacks PR or change identity`);
    if (
      item.pullRequest !== undefined &&
      (!Number.isSafeInteger(item.pullRequest) || Number(item.pullRequest) <= 0)
    )
      throw new Error(`Work Item ${id} PR identity is invalid`);
    if (
      item.selectedAssetSet !== undefined &&
      (typeof item.selectedAssetSet !== "string" ||
        !Array.isArray(item.assets) ||
        !item.assets.some(
          (set: { id?: unknown }) => set.id === item.selectedAssetSet,
        ))
    )
      throw new Error(`Work Item ${id} has an invalid asset selection`);
    if (item.selectionDigest !== undefined)
      sha(item.selectionDigest, `${id}.selectionDigest`, 64);
    if (item.assets !== undefined) {
      if (!Array.isArray(item.assets))
        throw new Error(`Work Item ${id} assets are invalid`);
      for (const rawSet of item.assets) {
        const set = record(rawSet, `work.${id}.assetSet`);
        string(set.id, "AssetSet ID");
        const provenance = record(set.provenance, "AssetSet provenance");
        string(provenance.source, "AssetSet source");
        string(provenance.rights, "AssetSet rights");
        if (!["private", "repository"].includes(String(provenance.visibility)))
          throw new Error("AssetSet visibility is invalid");
        strings(provenance.lineage, "AssetSet lineage");
        if (!Array.isArray(set.members) || !set.members.length)
          throw new Error("AssetSet has no members");
        const evidence = record(set.evidence, "AssetSet harness evidence");
        string(evidence.harnessIdentity, "AssetSet harness identity");
        sha(evidence.resultDigest, "AssetSet harness result digest", 64);
        for (const rawMember of set.members) {
          const member = record(rawMember, "AssetSet member");
          string(member.role, "AssetSet role");
          string(member.destination, "AssetSet destination");
          const ref = record(member.ref, "AssetSet content ref");
          sha(ref.digest, "AssetSet content digest", 64);
          if (
            !Number.isSafeInteger(ref.bytes) ||
            Number(ref.bytes) < 0 ||
            typeof ref.mediaType !== "string"
          )
            throw new Error("AssetSet content reference is invalid");
        }
      }
    }
    if (item.execution !== undefined) {
      const execution = record(item.execution, `work.${id}.execution`);
      if (
        execution.provider !== "local" ||
        typeof execution.identity !== "string"
      )
        throw new Error(`Work Item ${id} execution identity is invalid`);
      const active = record(execution.data, `work.${id}.execution.data`);
      const request = record(active.request, `work.${id}.execution.request`);
      const attemptedItem = record(request.item, `work.${id}.execution.item`);
      const handle = record(active.handle, `work.${id}.harness`);
      const host = record(handle.data, `work.${id}.harness.data`);
      if (
        typeof active.worktree !== "string" ||
        attemptedItem.id !== id ||
        request.baseSha !== item.baseSha ||
        typeof handle.identity !== "string" ||
        !Number.isSafeInteger(host.pid) ||
        typeof host.startTime !== "string" ||
        typeof host.resultPath !== "string"
      )
        throw new Error(`Work Item ${id} active attempt handle is invalid`);
    }
  }
  if (state.integratedSha !== undefined)
    sha(state.integratedSha, "integratedSha");
  if (state.stackNumbers !== undefined) {
    const numbers = record(state.stackNumbers, "stackNumbers");
    for (const [unit, number] of Object.entries(numbers))
      if (!unit || !Number.isSafeInteger(number) || Number(number) <= 0)
        throw new Error("Native stack identity is invalid");
  }
  if (state.stackMerges !== undefined) {
    const merges = record(state.stackMerges, "stackMerges");
    for (const [unit, raw] of Object.entries(merges)) {
      const merge = record(raw, `stackMerges.${unit}`);
      if (
        !unit ||
        !Number.isSafeInteger(merge.topPullRequest) ||
        Number(merge.topPullRequest) <= 0 ||
        typeof merge.uuid !== "string" ||
        !merge.uuid
      )
        throw new Error("Pending native merge identity is invalid");
      sha(merge.expectedHeadSha, "Pending native merge head");
    }
  }
  if (state.finalValidation !== undefined) {
    const final = record(state.finalValidation, "finalValidation");
    sha(final.treeSha, "final validation tree");
    if (
      final.passed !== true ||
      !Array.isArray(final.commands) ||
      !final.commands.every(
        (check) => typeof check?.command === "string" && check.passed === true,
      )
    )
      throw new Error("Final validation evidence is invalid");
  }
  if (state.objectiveCommands !== undefined)
    strings(state.objectiveCommands, "objectiveCommands");
  if (state.error !== undefined && typeof state.error !== "string")
    throw new Error("state.error is invalid");
  return value as FactoryState;
}
