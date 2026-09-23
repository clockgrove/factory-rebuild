import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  constants,
  fstatSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./config.js";
import type { FactoryState, WorkState } from "./state.js";
import { itemsConflict } from "./scheduler.js";
import { linearDeliveryUnits } from "./delivery/plan.js";

export interface DiagnosticEvent {
  at: string;
  repository: string;
  objective: number;
  runId?: string;
  itemId?: string;
  attemptId?: string;
  operation: string;
  outcome: "started" | "completed" | "waiting" | "failed" | "observed";
  durationMs?: number;
  /** Safe, bounded identities only. A future exporter may copy this field. */
  metadata?: Record<string, string | number | boolean>;
  /** Private local detail. Never send this to a remote exporter by default. */
  detail?: string;
}

export function redactDiagnosticDetail(
  value: string,
  secrets: string[] = [],
): string {
  let result = value
    .replace(
      /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g,
      "[REDACTED]",
    )
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, "$1[REDACTED]");
  for (const secret of secrets)
    if (secret.length >= 4) result = result.split(secret).join("[REDACTED]");
  return result;
}

export function diagnosticPath(repository: string, objective: number): string {
  return join(
    stateRoot(repository),
    "objectives",
    String(objective),
    "diagnostics.ndjson",
  );
}

export class DiagnosticEmitter {
  constructor(
    private repository: string,
    private objective: number,
    private secrets: string[] = [],
  ) {}

  emit(event: Omit<DiagnosticEvent, "at" | "repository" | "objective">): void {
    const path = diagnosticPath(this.repository, this.objective);
    const value: DiagnosticEvent = {
      at: new Date().toISOString(),
      repository: this.repository,
      objective: this.objective,
      ...event,
      detail:
        event.detail === undefined
          ? undefined
          : redactDiagnosticDetail(event.detail, this.secrets),
    };
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // Refuse links. Logs are observations; a write failure cannot change lifecycle.
      const fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_APPEND |
          constants.O_CREAT |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if ((fstatSync(fd).mode & 0o077) !== 0)
          throw new Error("diagnostic log permissions are too broad");
        appendFileSync(fd, `${JSON.stringify(value)}\n`);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      process.stderr.write(
        `Factory diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  async span<T>(
    context: Pick<
      DiagnosticEvent,
      "operation" | "runId" | "itemId" | "attemptId" | "metadata"
    >,
    task: () => Promise<T>,
    completedMetadata?: (
      result: T,
    ) => Record<string, string | number | boolean>,
  ): Promise<T> {
    const started = Date.now();
    this.emit({ ...context, outcome: "started" });
    try {
      const result = await task();
      let metadata = context.metadata;
      try {
        metadata = { ...metadata, ...completedMetadata?.(result) };
      } catch (error) {
        process.stderr.write(
          `Factory diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      this.emit({
        ...context,
        outcome: "completed",
        durationMs: Date.now() - started,
        metadata,
      });
      return result;
    } catch (error) {
      this.emit({
        ...context,
        outcome: "failed",
        durationMs: Date.now() - started,
        detail: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

export function readDiagnostics(
  repository: string,
  objective: number,
): DiagnosticEvent[] {
  const path = diagnosticPath(repository, objective);
  if (!existsSync(path)) return [];
  return completeLines(readPrivateFile(path)).map(
    (line) => JSON.parse(line) as DiagnosticEvent,
  );
}

function completeLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) !== "") lines.pop();
  return lines.filter(Boolean);
}

function readPrivateFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0)
      throw new Error(
        "Private diagnostic file is not a restricted regular file",
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export function readWorkerOutput(
  repository: string,
  attemptId: string,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      attemptId,
    )
  )
    throw new Error("Invalid worker attempt ID");
  const path = join(stateRoot(repository), "harness", `${attemptId}.log`);
  if (!existsSync(path))
    throw new Error("Worker output unavailable for this attempt");
  return readPrivateFile(path);
}

export function readAgentTimeline(
  repository: string,
  objective: number,
  state?: FactoryState,
): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = readDiagnostics(
    repository,
    objective,
  ).map((event) => ({ ...event }));
  const root = join(stateRoot(repository), "harness");
  if (existsSync(root)) {
    const itemByAttempt = new Map<string, string>(
      events
        .filter(
          (event) =>
            typeof event.attemptId === "string" &&
            typeof event.itemId === "string",
        )
        .map((event) => [event.attemptId as string, event.itemId as string]),
    );
    const runByAttempt = new Map<string, string>(
      events
        .filter(
          (event) =>
            typeof event.attemptId === "string" &&
            typeof event.runId === "string",
        )
        .map((event) => [event.attemptId as string, event.runId as string]),
    );
    for (const [id, work] of Object.entries(state?.work ?? {}))
      if (work.attempt) {
        itemByAttempt.set(work.attempt, id);
        if (state?.runId) runByAttempt.set(work.attempt, state.runId);
      }
    for (const name of readdirSync(root).filter((name) =>
      /^[0-9a-f-]{36}\.progress\.ndjson$/.test(name),
    )) {
      const path = join(root, name);
      for (const line of completeLines(readPrivateFile(path))) {
        const event = JSON.parse(line) as Record<string, unknown>;
        const attemptId = name.slice(0, 36);
        if (!itemByAttempt.has(attemptId)) continue;
        events.push({
          repository,
          objective,
          runId: runByAttempt.get(attemptId),
          workItemId: itemByAttempt.get(attemptId),
          ...event,
        });
      }
    }
  }
  return events.sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function statusDocument(
  state: FactoryState | undefined,
  repository: string,
  objective: number,
  delivery: "regular" | "native-stack",
  secrets: string[] = [],
) {
  if (!state)
    return { repository, objective, state: "not-started" as const, work: [] };
  const unitByItem = new Map(
    linearDeliveryUnits(state.graph).flatMap((unit) =>
      unit.items.map((item) => [item.id, unit.id] as const),
    ),
  );
  const work = state.graph.items.map((item) => {
    const current = state.work[item.id]!;
    let blockedReason: string | undefined;
    if (current.status === "pending") {
      const dependency = item.dependencies.find(
        (id) =>
          state.work[id]?.status !== "done" &&
          !(
            delivery === "native-stack" &&
            state.work[id]?.status === "published" &&
            unitByItem.get(id) === unitByItem.get(item.id)
          ),
      );
      const conflict = state.graph.items.find(
        (candidate) =>
          state.work[candidate.id]?.status === "running" &&
          itemsConflict(item, candidate),
      );
      blockedReason = dependency
        ? `dependency:${dependency}`
        : conflict
          ? `resource:${conflict.id}`
          : undefined;
    } else if (current.status === "waiting")
      blockedReason = current.waitingReason ?? "asset-selection";
    return {
      id: item.id,
      issue: state.issueByItemId[item.id],
      status: current.status,
      step: current.step ?? null,
      ready: current.status === "pending" && !blockedReason,
      blockedReason: blockedReason ?? null,
      attemptId: current.attempt ?? null,
      providerProgress:
        current.attempt &&
        existsSync(
          join(
            stateRoot(repository),
            "harness",
            `${current.attempt}.progress.ndjson`,
          ),
        )
          ? "streamed"
          : "unavailable",
      baseSha: current.baseSha ?? null,
      treeSha: current.treeSha ?? null,
      headSha: current.changeRef ?? null,
      pullRequest: current.pullRequest ?? null,
      stack: state.stackNumbers?.[unitByItem.get(item.id) ?? ""] ?? null,
      candidateAssetSets: current.assets?.map((set) => set.id) ?? [],
      selectedAssetSet: current.selectedAssetSet ?? null,
      lastError: current.error
        ? redactDiagnosticDetail(current.error, secrets)
        : null,
    };
  });
  return {
    repository,
    objective,
    state: state.cancelledAt
      ? ("cancelled" as const)
      : state.error
        ? ("failed" as const)
        : state.finalValidation?.passed
          ? ("complete" as const)
          : ("active" as const),
    runId: state.runId,
    baseSha: state.baseSha,
    integratedSha: state.integratedSha ?? null,
    finalValidation: state.finalValidation?.passed ?? false,
    objectiveClosure: state.objectiveClosure ?? null,
    lastError:
      state.error || state.githubClosureError
        ? redactDiagnosticDetail(
            state.error ?? state.githubClosureError!,
            secrets,
          )
        : null,
    work,
  };
}

/** Observe snapshot changes after saving; the snapshot alone controls continuation. */
export class StateDiagnostics {
  private previous = new Map<string, WorkState>();
  private previousReadiness = new Map<string, string>();
  private previousStacks = new Map<string, number>();
  private previousFinal = false;
  private previousIntegrated?: string;
  constructor(
    private emitter: DiagnosticEmitter,
    private state: FactoryState,
    private delivery: "regular" | "native-stack",
  ) {}

  observe(): void {
    for (const [id, work] of Object.entries(this.state.work)) {
      const before = this.previous.get(id);
      if (
        before?.execution?.identity !== work.execution?.identity &&
        (before?.execution || work.execution)
      ) {
        this.emitter.emit({
          runId: this.state.runId,
          itemId: id,
          attemptId: work.attempt,
          operation: "harness",
          outcome: !before
            ? "observed"
            : work.execution
              ? "started"
              : "completed",
          durationMs:
            before?.execution && !work.execution && work.startedAt
              ? Math.max(0, Date.now() - Date.parse(work.startedAt))
              : undefined,
          metadata: {
            provider:
              work.execution?.provider ??
              before?.execution?.provider ??
              "unknown",
          },
        });
      }
      if (
        !before ||
        before.status !== work.status ||
        before.step !== work.step ||
        before.pullRequest !== work.pullRequest ||
        before.githubClosure !== work.githubClosure
      ) {
        const outcome = !before
          ? "observed"
          : work.status === "failed" || work.status === "cancelled"
            ? "failed"
            : work.status === "waiting"
              ? "waiting"
              : work.status === "done"
                ? "completed"
                : work.status === "pending"
                  ? "observed"
                  : "started";
        const operation =
          before?.githubClosure !== work.githubClosure &&
          work.githubClosure === "complete"
            ? "github-closure"
            : (work.step ??
              (work.pullRequest && work.status === "done"
                ? "merge"
                : work.status));
        this.emitter.emit({
          runId: this.state.runId,
          itemId: id,
          attemptId: work.attempt,
          operation,
          outcome,
          durationMs:
            work.completedAt && work.startedAt
              ? Math.max(
                  0,
                  Date.parse(work.completedAt) - Date.parse(work.startedAt),
                )
              : undefined,
          metadata: {
            ...(this.state.issueByItemId[id]
              ? { issue: this.state.issueByItemId[id] }
              : {}),
            ...(work.pullRequest ? { pullRequest: work.pullRequest } : {}),
            ...(work.baseSha ? { baseSha: work.baseSha } : {}),
            ...(work.treeSha ? { treeSha: work.treeSha } : {}),
          },
          detail: work.error,
        });
      }
      this.previous.set(id, { ...work });
    }
    const view = statusDocument(
      this.state,
      this.state.repository,
      this.state.objective,
      this.delivery,
    );
    for (const item of view.work) {
      const reason =
        item.status === "pending"
          ? (item.blockedReason ?? "ready")
          : "inactive";
      if (
        reason !== this.previousReadiness.get(item.id) &&
        item.status === "pending"
      )
        this.emitter.emit({
          runId: this.state.runId,
          itemId: item.id,
          operation: "scheduling",
          outcome: item.blockedReason ? "waiting" : "observed",
          metadata: { reason },
        });
      this.previousReadiness.set(item.id, reason);
    }
    for (const [unit, number] of Object.entries(this.state.stackNumbers ?? {}))
      if (this.previousStacks.get(unit) !== number) {
        this.emitter.emit({
          runId: this.state.runId,
          operation: "github-stack",
          outcome: "completed",
          metadata: { unit, stack: number },
        });
        this.previousStacks.set(unit, number);
      }
    if (
      this.state.integratedSha !== this.previousIntegrated &&
      this.state.integratedSha
    ) {
      this.emitter.emit({
        runId: this.state.runId,
        operation: "integrated-head",
        outcome: "completed",
        metadata: { headSha: this.state.integratedSha },
      });
      this.previousIntegrated = this.state.integratedSha;
    }
    if (this.state.finalValidation?.passed && !this.previousFinal) {
      this.emitter.emit({
        runId: this.state.runId,
        operation: "objective-finalization",
        outcome: "completed",
        metadata: { integratedSha: this.state.integratedSha ?? "" },
      });
      this.previousFinal = true;
    }
  }
}
