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
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { stateRoot } from "./config.js";
import type { FactoryState, WorkState } from "./state.js";
import { itemsConflict } from "./scheduler.js";
import { linearDeliveryUnits } from "./delivery/plan.js";

export interface DiagnosticEvent {
  eventId: string;
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
    for (const line of secret.split(/\r?\n/))
      if (line.length) result = result.split(line).join("[REDACTED]");
  return result;
}

/** Keep only a suffix that could become a secret when the next chunk arrives. */
function safeStreamingPrefixLength(value: string, secrets: string[]): number {
  let hold = 0;
  const candidates = [
    ...secrets.flatMap((secret) => secret.split(/\r?\n/)).filter(Boolean),
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-",
    "Authorization:",
  ];
  for (const candidate of candidates)
    for (let length = 1; length < candidate.length; length++)
      if (
        value.toLowerCase().endsWith(candidate.slice(0, length).toLowerCase())
      )
        hold = Math.max(hold, length);
  for (const prefix of [
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "sk-",
  ]) {
    const index = value.lastIndexOf(prefix);
    if (
      index >= 0 &&
      /^[A-Za-z0-9_-]*$/.test(value.slice(index + prefix.length))
    )
      hold = Math.max(hold, value.length - index);
  }
  const bearer = value.match(/Authorization:\s*Bearer\s+\S*$/i);
  if (bearer) hold = Math.max(hold, bearer[0].length);
  const partialBearer = value.match(
    /Authorization:\s*(?:B(?:e(?:a(?:r(?:e(?:r)?)?)?)?)?)?$/i,
  );
  if (partialBearer) hold = Math.max(hold, partialBearer[0].length);
  return value.length - hold;
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
  private streamBuffers = new Map<string, string>();
  constructor(
    private repository: string,
    private objective: number,
    private secrets: string[] = [],
  ) {}

  emit(
    event: Omit<DiagnosticEvent, "eventId" | "at" | "repository" | "objective">,
  ): void {
    const path = diagnosticPath(this.repository, this.objective);
    const value: DiagnosticEvent = {
      eventId: randomUUID(),
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

  emitStream(
    event: Omit<
      DiagnosticEvent,
      "eventId" | "at" | "repository" | "objective" | "detail"
    >,
    chunk: string,
    final = false,
  ): void {
    const key = JSON.stringify(event);
    const pending = (this.streamBuffers.get(key) ?? "") + chunk;
    const cut = final
      ? pending.length
      : safeStreamingPrefixLength(pending, this.secrets);
    if (cut) this.emit({ ...event, detail: pending.slice(0, cut) });
    if (final) this.streamBuffers.delete(key);
    else this.streamBuffers.set(key, pending.slice(cut));
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
    errorOutcome?: (error: unknown) => "waiting" | "failed",
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
        outcome: errorOutcome?.(error) ?? "failed",
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
  concurrency?: number,
) {
  if (!state)
    return { repository, objective, state: "not-started" as const, work: [] };
  const unitByItem = new Map(
    linearDeliveryUnits(state.graph).flatMap((unit) =>
      unit.items.map((item) => [item.id, unit.id] as const),
    ),
  );
  const pendingDecision = (pending: FactoryState["finalAcceptancePending"]) =>
    pending
      ? {
          criterion: redactDiagnosticDetail(pending.criterion, secrets),
          treeSha: pending.treeSha,
          source: pending.source,
          question: redactDiagnosticDetail(pending.question, secrets),
          detail: redactDiagnosticDetail(pending.detail, secrets),
          reviewFinding: pending.reviewFinding
            ? Object.fromEntries(
                Object.entries(pending.reviewFinding).map(([key, value]) => [
                  key,
                  redactDiagnosticDetail(value, secrets),
                ]),
              )
            : null,
          reviewRejection: pending.reviewRejection ?? null,
        }
      : null;
  const activeCount = Object.values(state.work).filter(
    (item) => item.status === "running",
  ).length;
  const configuredSlots =
    concurrency === undefined
      ? undefined
      : Math.max(0, concurrency - activeCount);
  const work = state.graph.items.map((item) => {
    const current = state.work[item.id]!;
    let blockedReason: string | undefined;
    let eligible = false;
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
      eligible = !dependency && !conflict;
      blockedReason = dependency
        ? `dependency:${dependency}`
        : conflict
          ? `resource:${conflict.id}`
          : configuredSlots === 0
            ? "capacity"
            : undefined;
    } else if (current.status === "waiting")
      blockedReason =
        current.step === "approve-result"
          ? "acceptance-decision"
          : (current.waitingReason ?? "asset-selection");
    return {
      id: item.id,
      issue: state.issueByItemId[item.id],
      status: current.status,
      step: current.step ?? null,
      eligible,
      // Provider capacity is not persisted in the state snapshot.
      ready: current.status === "pending" && !blockedReason ? null : false,
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
      acceptancePending: pendingDecision(current.acceptancePending),
      lastError: current.error
        ? redactDiagnosticDetail(current.error, secrets)
        : null,
      authentication: current.authentication
        ? {
            provider: redactDiagnosticDetail(
              current.authentication.provider,
              secrets,
            ),
            command: redactDiagnosticDetail(
              current.authentication.command,
              secrets,
            ),
          }
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
        : state.finalAcceptancePending
          ? ("waiting" as const)
          : state.finalValidation?.passed
            ? ("complete" as const)
            : ("active" as const),
    runId: state.runId,
    configuredSlots: configuredSlots ?? null,
    baseSha: state.baseSha,
    integratedSha: state.integratedSha ?? null,
    finalValidation: state.finalValidation?.passed ?? false,
    finalAcceptancePending: pendingDecision(state.finalAcceptancePending),
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
  private previousFinalPending?: string | null;
  private previousIntegrated?: string;
  constructor(
    private emitter: DiagnosticEmitter,
    private state: FactoryState,
    private delivery: "regular" | "native-stack",
    private concurrency: number,
  ) {}

  observe(): void {
    for (const [id, work] of Object.entries(this.state.work)) {
      const before = this.previous.get(id);
      if (
        work.acceptancePending &&
        before?.acceptancePending?.treeSha !== work.acceptancePending.treeSha
      ) {
        this.emitter.emit({
          runId: this.state.runId,
          itemId: id,
          attemptId: work.attempt,
          operation: "acceptance-pending",
          outcome: before ? "waiting" : "observed",
          metadata: { treeSha: work.acceptancePending.treeSha },
          detail: JSON.stringify({
            question: work.acceptancePending.question,
            detail: work.acceptancePending.detail,
            reviewFinding: work.acceptancePending.reviewFinding ?? null,
            reviewRejection: work.acceptancePending.reviewRejection ?? null,
          }),
        });
      }
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
    const finalPending = this.state.finalAcceptancePending?.treeSha ?? null;
    if (finalPending && finalPending !== this.previousFinalPending)
      this.emitter.emit({
        runId: this.state.runId,
        operation: "objective-acceptance-pending",
        outcome:
          this.previousFinalPending === undefined ? "observed" : "waiting",
        metadata: { treeSha: finalPending },
        detail: this.state.finalAcceptancePending
          ? JSON.stringify({
              question: this.state.finalAcceptancePending.question,
              detail: this.state.finalAcceptancePending.detail,
              reviewFinding:
                this.state.finalAcceptancePending.reviewFinding ?? null,
              reviewRejection:
                this.state.finalAcceptancePending.reviewRejection ?? null,
            })
          : undefined,
      });
    this.previousFinalPending = finalPending;
    const view = statusDocument(
      this.state,
      this.state.repository,
      this.state.objective,
      this.delivery,
      [],
      this.concurrency,
    );
    for (const item of view.work) {
      const reason =
        item.status === "pending"
          ? (item.blockedReason ?? "eligible-provider-unknown")
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
    if (
      this.state.finalValidation?.passed &&
      this.state.objectiveClosure === "complete" &&
      !this.previousFinal
    ) {
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
