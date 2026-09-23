import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  closeSync,
  constants,
  statSync,
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
        if ((statSync(path).mode & 0o077) !== 0)
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
}

export function readDiagnostics(
  repository: string,
  objective: number,
): DiagnosticEvent[] {
  const path = diagnosticPath(repository, objective);
  if (!existsSync(path)) return [];
  if ((statSync(path).mode & 0o077) !== 0)
    throw new Error("Diagnostic log permissions are too broad");
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DiagnosticEvent);
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
    for (const [id, work] of Object.entries(state?.work ?? {}))
      if (work.attempt) itemByAttempt.set(work.attempt, id);
    for (const name of readdirSync(root).filter((name) =>
      /^[0-9a-f-]{36}\.progress\.ndjson$/.test(name),
    )) {
      const path = join(root, name);
      if ((statSync(path).mode & 0o077) !== 0)
        throw new Error("Worker progress permissions are too broad");
      for (const line of readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)) {
        const event = JSON.parse(line) as Record<string, unknown>;
        const attemptId = name.slice(0, 36);
        if (!itemByAttempt.has(attemptId)) continue;
        events.push({
          repository,
          objective,
          runId: state?.runId,
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
      baseSha: current.baseSha ?? null,
      treeSha: current.treeSha ?? null,
      headSha: current.changeRef ?? null,
      pullRequest: current.pullRequest ?? null,
      stack:
        Object.entries(state.stackNumbers ?? {}).find(
          ([key]) => key === item.id,
        )?.[1] ?? null,
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
  private previousFinal = false;
  private previousIntegrated?: string;
  constructor(
    private emitter: DiagnosticEmitter,
    private state: FactoryState,
  ) {}

  observe(): void {
    for (const [id, work] of Object.entries(this.state.work)) {
      const before = this.previous.get(id);
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
