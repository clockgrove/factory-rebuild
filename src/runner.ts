import { createHash, randomUUID } from "node:crypto";
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { userInfo } from "node:os";
import type { FactoryConfig } from "./config.js";
import { stateRoot, validateTarget } from "./config.js";
import type { FactoryState } from "./state.js";
import {
  closeObjectiveIssue,
  closeWorkItem,
  GitHubClosureFailure,
} from "./completion.js";
import {
  compilePlan,
  finalObjectiveCommands,
  objectiveCriteria,
  planningSources,
  resolvePlan,
  validateCommandProvenance,
  verifyPlanCandidate,
  type PlanCandidate,
} from "./compiler.js";
import type {
  ContentStore,
  DeliveryStrategy,
  ExecutionDriver,
  GitHubGateway,
  PlanningModel,
} from "./contracts.js";
import { assetSelectionDigest, verifyHydratedAssets } from "./media.js";
import { runNativeGraph } from "./delivery/native-runner.js";
import { linearDeliveryUnits } from "./delivery/plan.js";
import { runRegularGraph } from "./delivery/regular-runner.js";
import { git, linuxProcessIdentity, pinnedGit } from "./process.js";
import {
  AcceptanceDecisionRequired,
  assertPinnedNpmScripts,
  reviewAcceptance,
  validateTree,
} from "./validation.js";
import { DiagnosticEmitter, StateDiagnostics } from "./diagnostics.js";
import {
  acquireControllerLock,
  readControllerOwner,
  readState,
  releaseControllerLock,
  saveState,
  statePath,
} from "./state-store.js";

export interface ApplicationServices {
  planningModel: PlanningModel;
  driver: ExecutionDriver;
  github: GitHubGateway;
  delivery: DeliveryStrategy;
  contentStore: ContentStore;
}

/** Read-only preflight: no controller lock, issue projection, or run state. */
export async function planObjective(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "planningModel" | "github">,
): Promise<PlanCandidate> {
  validateTarget(config.repository, config.checkout);
  const diagnostics = new DiagnosticEmitter(config.repository, objective);
  const started = Date.now();
  diagnostics.emit({ operation: "planning-preview", outcome: "started" });
  try {
    const issue = await services.github.objective(objective);
    const baseSha = git(config.checkout, "rev-parse", "HEAD");
    const result = await compilePlan(
      objective,
      issue.body,
      baseSha,
      config.checkout,
      services.planningModel,
    );
    diagnostics.emit({
      operation: "planning-preview",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: {
        baseSha,
        review: result.review.status,
        itemCount: result.graph.items.length,
      },
    });
    return result;
  } catch (error) {
    diagnostics.emit({
      operation: "planning-preview",
      outcome: "failed",
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function decidePlan(
  config: FactoryConfig,
  objective: number,
  services: Pick<ApplicationServices, "planningModel" | "github">,
  candidate: PlanCandidate,
  input: {
    actor: string;
    outcome: "accept" | "refuse";
    answer: string;
    reason: string;
  },
): Promise<PlanCandidate> {
  validateTarget(config.repository, config.checkout);
  const diagnostics = new DiagnosticEmitter(config.repository, objective);
  const started = Date.now();
  diagnostics.emit({ operation: "planning-decision", outcome: "started" });
  try {
    const issue = await services.github.objective(objective);
    const baseSha = git(config.checkout, "rev-parse", "HEAD");
    const result = await resolvePlan(
      candidate,
      objective,
      issue.body,
      baseSha,
      config.checkout,
      services.planningModel,
      input,
    );
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "completed",
      durationMs: Date.now() - started,
      metadata: { review: result.review.status },
    });
    return result;
  } catch (error) {
    diagnostics.emit({
      operation: "planning-decision",
      outcome: "failed",
      durationMs: Date.now() - started,
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export async function runObjective(
  config: FactoryConfig,
  objective: number,
  services: ApplicationServices,
  acceptedPlan?: PlanCandidate,
): Promise<FactoryState> {
  validateTarget(config.repository, config.checkout);
  if (config.execution.kind !== "local")
    throw new Error("Current trunk supports local execution only");
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, "controller.lock");
  const lockHandle = acquireControllerLock(lock, objective);
  const path = statePath(config.repository, objective);
  const diagnostics = new DiagnosticEmitter(
    config.repository,
    objective,
    config.policy.allowedSecretNames
      .map((name) => process.env[name])
      .filter((value): value is string => Boolean(value)),
  );
  let stateDiagnostics: StateDiagnostics | undefined;
  const save = (state: FactoryState) => {
    saveState(path, state);
    try {
      stateDiagnostics?.observe();
    } catch (error) {
      process.stderr.write(
        `Factory diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };
  const active = new Map<string, Promise<void>>();
  const { driver, github, delivery, contentStore, planningModel } = services;
  let stateForSignal: FactoryState | undefined;
  let cancellationRequested = false;
  const onCancel = () => {
    cancellationRequested = true;
    if (stateForSignal) {
      stateForSignal.cancelRequested = true;
      save(stateForSignal);
    }
    if (stateForSignal) {
      for (const id of active.keys()) {
        const handle = stateForSignal.work[id]?.execution;
        if (handle) void driver.cancel(handle).catch(() => undefined);
      }
    }
  };
  process.on("SIGUSR1", onCancel);
  try {
    diagnostics.emit({ operation: "objective-run", outcome: "started" });
    const issue = await github.objective(objective);
    const configDigest = createHash("sha256")
      .update(JSON.stringify(config))
      .digest("hex");
    let state = readState(config.repository, objective);
    if (state) {
      if (
        state.schemaVersion !== 1 ||
        state.repository !== config.repository ||
        state.configDigest !== configDigest
      ) {
        throw new Error(
          "Existing Objective state does not match this Factory installation",
        );
      }
      if (acceptedPlan) {
        verifyPlanCandidate(
          acceptedPlan,
          objective,
          issue.body,
          state.baseSha,
          config.checkout,
        );
        if (JSON.stringify(acceptedPlan.graph) !== JSON.stringify(state.graph))
          throw new Error(
            "Accepted plan differs from the already active Objective graph",
          );
      }
      if (state.error)
        throw new Error(
          `Objective stopped: ${state.error}. Use explicit retry or operator direction.`,
        );
      if (
        state.objectiveBodyDigest &&
        state.objectiveBodyDigest !==
          createHash("sha256").update(issue.body).digest("hex")
      )
        throw new Error(
          "Objective issue body changed; operator direction required",
        );
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        config.execution.concurrency,
      );
      const saveCurrent = () => save(state!);
      for (const item of state.graph.items)
        if (state.work[item.id]?.status === "done")
          await closeWorkItem(
            state,
            item.id,
            github,
            saveCurrent,
            config.delivery.kind === "native-stack",
          );
      if (state.finalValidation?.passed) {
        await closeObjectiveIssue(state, issue.body, github, saveCurrent);
        return state;
      }
      if (state.cancelRequested || state.cancelledAt)
        throw new Error(
          "Objective was cancelled; use explicit retry or operator direction",
        );
    } else {
      const objectivesRoot = join(root, "objectives");
      if (existsSync(objectivesRoot)) {
        for (const name of readdirSync(objectivesRoot)) {
          if (!/^\d+$/.test(name) || Number(name) === objective) continue;
          const other = readState(config.repository, Number(name));
          if (other && !other.finalValidation?.passed && !other.cancelledAt)
            throw new Error(
              `Objective #${name} is already active in this installation`,
            );
        }
      }
      const baseSha = git(config.checkout, "rev-parse", "HEAD");
      const plan = await diagnostics.span(
        { operation: "planning", metadata: { baseSha } },
        async () => {
          const candidate =
            acceptedPlan ??
            (await compilePlan(
              objective,
              issue.body,
              baseSha,
              config.checkout,
              planningModel,
            ));
          verifyPlanCandidate(
            candidate,
            objective,
            issue.body,
            baseSha,
            config.checkout,
          );
          if (acceptedPlan) {
            const freshReview = await planningModel.reviewGraph({
              objective: issue.body,
              baseSha,
              sources: candidate.sources,
              graph: candidate.graph,
            });
            if (freshReview.findings.length)
              throw new Error(
                `Accepted plan no longer passes independent review: ${freshReview.findings[0]!.question}`,
              );
          }
          return candidate;
        },
        (candidate) => ({ itemCount: candidate.graph.items.length }),
      );
      const graph = plan.graph;
      const projected = await diagnostics.span(
        {
          operation: "github-projection",
          metadata: { itemCount: graph.items.length },
        },
        () => github.projectGraph({ graph, objectiveIssue: objective }),
      );
      state = {
        schemaVersion: 1,
        repository: config.repository,
        objective,
        runId: randomUUID(),
        configDigest,
        baseSha,
        graph,
        objectiveCommands: finalObjectiveCommands(issue.body),
        objectiveBodyDigest: createHash("sha256")
          .update(issue.body)
          .digest("hex"),
        issueByItemId: projected.issueByItemId,
        work: Object.fromEntries(
          graph.items.map((item) => [item.id, { status: "pending" }]),
        ),
      };
      stateDiagnostics = new StateDiagnostics(
        diagnostics,
        state,
        config.delivery.kind,
        config.execution.concurrency,
      );
    }
    const graph = state.graph;
    validateCommandProvenance(
      graph,
      planningSources(issue.body, state.baseSha, config.checkout),
      config.checkout,
    );
    stateForSignal = state;
    save(state);
    if (config.delivery.kind === "native-stack") {
      await runNativeGraph({
        config,
        objective,
        objectiveBody: issue.body,
        root,
        state,
        driver,
        delivery,
        contentStore,
        github,
        planningModel,
        save: () => save(state),
        active,
        cancelled: () => cancellationRequested,
        diagnostics,
      });
      if (graph.items.some((item) => state.work[item.id]?.status === "waiting"))
        return state;
    } else {
      const awaitingSelection = await runRegularGraph({
        config,
        objective,
        objectiveBody: issue.body,
        root,
        state,
        driver,
        delivery,
        contentStore,
        github,
        planningModel,
        save: () => save(state),
        active,
        cancelled: () => cancellationRequested,
        diagnostics,
      });
      if (awaitingSelection) return state;
    }
    git(config.checkout, "fetch", "origin", github.defaultBranch());
    const integratedSha = state.integratedSha!;
    const observedHead = git(config.checkout, "rev-parse", "FETCH_HEAD");
    if (observedHead !== integratedSha)
      throw new Error(
        `Default branch changed before final validation: expected ${integratedSha}, observed ${observedHead}`,
      );
    const finalTree = git(
      config.checkout,
      "rev-parse",
      `${integratedSha}^{tree}`,
    );
    const finalValidationStarted = Date.now();
    diagnostics.emit({
      runId: state.runId,
      operation: "objective-validation",
      outcome: "started",
      metadata: { integratedSha, treeSha: finalTree },
    });
    assertPinnedNpmScripts(
      config.checkout,
      state.baseSha,
      integratedSha,
      state.objectiveCommands ?? finalObjectiveCommands(issue.body),
    );
    const commandEvidence = await validateTree(
      config.checkout,
      join(root, "final-validation"),
      integratedSha,
      finalTree,
      state.objectiveCommands ?? finalObjectiveCommands(issue.body),
      (entry) =>
        diagnostics.emit({
          runId: state.runId,
          operation: "objective-validation-command",
          outcome: entry.passed ? "completed" : "failed",
          durationMs: entry.durationMs,
          metadata: { commandIndex: entry.index, exitCode: entry.exitCode },
          detail: entry.output,
        }),
      (entry) =>
        diagnostics.emitStream(
          {
            runId: state.runId,
            operation: "objective-validation-output",
            outcome: "observed",
            metadata: { commandIndex: entry.index, stream: entry.stream },
          },
          entry.output,
          entry.final,
        ),
    );
    let finalEvidence;
    try {
      const reviewFinal = () =>
        reviewAcceptance({
          model: planningModel,
          checkout: config.checkout,
          baseSha: state.baseSha,
          commit: integratedSha,
          evidence: commandEvidence,
          criteria: objectiveCriteria(issue.body),
          sources: planningSources(issue.body, state.baseSha, config.checkout),
          decisions: state.finalAcceptanceDecisions,
          observations: JSON.stringify({
            integratedSha,
            work: graph.items.map((item) => {
              const work = state.work[item.id]!;
              return {
                id: item.id,
                status: work.status,
                treeSha: work.treeSha,
                validation: work.validation,
                pullRequest: work.pullRequest,
                integratedSha: work.integratedSha,
                selectedAssetSet: work.selectedAssetSet,
                selectedAsset: work.assets?.find(
                  (set) => set.id === work.selectedAssetSet,
                ),
                selection: work.selection,
              };
            }),
          }),
        });
      finalEvidence = await diagnostics.span(
        {
          runId: state.runId,
          operation: "objective-acceptance-review",
          metadata: { treeSha: finalTree, integratedSha },
        },
        reviewFinal,
        (result) => ({ criteria: result.criteria?.length ?? 0 }),
        (error) =>
          error instanceof AcceptanceDecisionRequired ? "waiting" : "failed",
      );
      delete state.finalAcceptancePending;
    } catch (error) {
      if (error instanceof AcceptanceDecisionRequired) {
        state.finalAcceptancePending = error.pending;
        save(state);
        diagnostics.emit({
          runId: state.runId,
          operation: "objective-validation",
          outcome: "waiting",
          durationMs: Date.now() - finalValidationStarted,
          metadata: { treeSha: finalTree },
          detail: error.pending.question,
        });
        return state;
      }
      throw error;
    }
    verifyHydratedAssets({
      checkout: config.checkout,
      workRoot: join(root, "hydration"),
      integratedSha,
      sets: graph.items.flatMap((item) => {
        const work = state.work[item.id];
        return (
          work?.assets?.filter((set) => set.id === work.selectedAssetSet) ?? []
        );
      }),
    });
    state.finalValidation = { ...finalEvidence, passed: true };
    diagnostics.emit({
      runId: state.runId,
      operation: "objective-validation",
      outcome: "completed",
      durationMs: Date.now() - finalValidationStarted,
      metadata: { treeSha: finalTree, integratedSha },
    });
    save(state);
    await closeObjectiveIssue(state, issue.body, github, () => save(state));
    return state;
  } catch (error) {
    diagnostics.emit({
      runId: stateForSignal?.runId,
      operation: "objective-run",
      outcome: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    for (const item of active.keys()) {
      const handle = readState(config.repository, objective)?.work[item]
        ?.execution;
      if (handle) await driver.cancel(handle).catch(() => undefined);
    }
    await Promise.allSettled(active.values());
    if (existsSync(path)) {
      const state = readState(config.repository, objective)!;
      if (cancellationRequested || state.cancelRequested) {
        state.cancelRequested = true;
        state.cancelledAt = new Date().toISOString();
        for (const work of Object.values(state.work))
          if (work.status === "running" || work.status === "pending")
            work.status = "cancelled";
      } else if (error instanceof GitHubClosureFailure) {
        state.githubClosureError = error.message;
      } else {
        state.error = error instanceof Error ? error.message : String(error);
      }
      save(state);
    }
    throw error;
  } finally {
    process.off("SIGUSR1", onCancel);
    releaseControllerLock(lock, lockHandle);
  }
}

export async function cancelObjective(
  config: FactoryConfig,
  objective: number,
  driver: ExecutionDriver,
): Promise<"requested" | "cancelled"> {
  const root = stateRoot(config.repository);
  const lock = join(root, "controller.lock");
  const owner = readControllerOwner(lock);
  if (owner) {
    const current = linuxProcessIdentity(owner.pid);
    if (current?.startTime === owner.startTime && current.state !== "Z") {
      if (owner.objective !== objective)
        throw new Error(`Controller is running Objective #${owner.objective}`);
      process.kill(owner.pid, "SIGUSR1");
      return "requested";
    }
  }
  const lockHandle = acquireControllerLock(lock, objective);
  try {
    const state = readState(config.repository, objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (state.finalValidation?.passed || state.cancelledAt) return "cancelled";
    for (const work of Object.values(state.work)) {
      if (work.status !== "running") continue;
      if (!work.execution)
        throw new Error(
          "Active attempt has no stable handle; operator direction required",
        );
      await driver.cancel(work.execution);
      await driver.collect(work.execution).catch(() => undefined);
      work.status = "cancelled";
      work.completedAt = new Date().toISOString();
    }
    for (const work of Object.values(state.work))
      if (work.status === "pending") work.status = "cancelled";
    state.cancelRequested = true;
    state.cancelledAt = new Date().toISOString();
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      operation: "objective-cancel",
      outcome: "completed",
    });
    return "cancelled";
  } finally {
    releaseControllerLock(lock, lockHandle);
  }
}

export function retryWorkItem(
  config: FactoryConfig,
  objective: number,
  itemId: string,
): void {
  const root = stateRoot(config.repository);
  const lock = join(root, "controller.lock");
  const lockHandle = acquireControllerLock(lock, objective);
  try {
    const state = readState(config.repository, objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (state.finalValidation?.passed)
      throw new Error("Objective is already complete");
    if (Object.values(state.work).some((work) => work.status === "running"))
      throw new Error("Finish or cancel active work before retry");
    const work = state.work[itemId];
    if (!work || (work.status !== "failed" && work.status !== "cancelled"))
      throw new Error("Only a failed or cancelled Work Item can be retried");
    const nativeUnit =
      config.delivery.kind === "native-stack"
        ? linearDeliveryUnits(state.graph).find((unit) =>
            unit.items.some((item) => item.id === itemId),
          )
        : undefined;
    if (
      work.pullRequest ||
      work.step === "deliver" ||
      nativeUnit?.items.some((item) => state.work[item.id]?.pullRequest) ||
      (nativeUnit &&
        (state.stackNumbers?.[nativeUnit.id] ||
          state.stackMerges?.[nativeUnit.id]))
    )
      throw new Error("Published PR requires operator direction before retry");
    state.work[itemId] = { status: "pending" };
    state.cancelRequested = false;
    delete state.cancelledAt;
    delete state.error;
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId,
      operation: "work-retry",
      outcome: "completed",
    });
  } finally {
    releaseControllerLock(lock, lockHandle);
  }
}

/** Record one explicit result decision against the exact pending tree. */
export function decideResult(
  config: FactoryConfig,
  objective: number,
  input: {
    item?: string;
    treeSha: string;
    actor: string;
    outcome: "accept" | "refuse";
    reason: string;
  },
): void {
  const root = stateRoot(config.repository);
  const lockHandle = acquireControllerLock(
    join(root, "controller.lock"),
    objective,
  );
  try {
    const path = statePath(config.repository, objective);
    const state = readState(config.repository, objective);
    if (
      !state ||
      state.error ||
      state.cancelledAt ||
      state.finalValidation?.passed
    )
      throw new Error("Objective is not awaiting a result decision");
    const work = input.item ? state.work[input.item] : undefined;
    const pending = input.item
      ? work?.acceptancePending
      : state.finalAcceptancePending;
    const commit = input.item ? work?.changeRef : state.integratedSha;
    if (
      !pending ||
      !commit ||
      (work && (work.status !== "waiting" || work.step !== "approve-result"))
    )
      throw new Error(
        "No specific acceptance criterion is awaiting this decision",
      );
    const observedTree = pinnedGit(
      config.checkout,
      "rev-parse",
      `${commit}^{tree}`,
    );
    if (pending.treeSha !== input.treeSha || observedTree !== input.treeSha)
      throw new Error(
        "Result decision tree differs from the pending exact result",
      );
    if (
      !input.actor.trim() ||
      !input.reason.trim() ||
      !["accept", "refuse"].includes(input.outcome)
    )
      throw new Error("Result decision requires actor and reason");
    const decision = {
      criterion: pending.criterion,
      treeSha: pending.treeSha,
      actor: input.actor,
      at: new Date().toISOString(),
      outcome: input.outcome,
      reason: input.reason,
    };
    if (work) {
      work.acceptanceDecisions ??= [];
      work.acceptanceDecisions.push(decision);
      delete work.acceptancePending;
      work.status = input.outcome === "accept" ? "running" : "failed";
      work.step = "validate";
      if (input.outcome === "refuse")
        work.error = `Acceptance refused: ${pending.criterion}`;
    } else {
      state.finalAcceptanceDecisions ??= [];
      state.finalAcceptanceDecisions.push(decision);
      delete state.finalAcceptancePending;
      if (input.outcome === "refuse")
        state.error = `Final acceptance refused: ${pending.criterion}`;
    }
    saveState(path, state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId: input.item,
      attemptId: work?.attempt,
      operation: input.item
        ? "acceptance-decision"
        : "objective-acceptance-decision",
      outcome: input.outcome === "accept" ? "completed" : "failed",
      metadata: { treeSha: pending.treeSha },
      detail: input.reason,
    });
  } finally {
    releaseControllerLock(join(root, "controller.lock"), lockHandle);
  }
}

export async function selectAssetSet(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  setId: string,
  store: ContentStore,
  decision?: { actor?: string; reason?: string; downstreamItems?: string[] },
): Promise<void> {
  const root = stateRoot(config.repository);
  const lock = join(root, "controller.lock");
  const lockHandle = acquireControllerLock(lock, objective);
  try {
    const state = readState(config.repository, objective);
    if (!state || state.error || state.cancelledAt)
      throw new Error("Objective is not awaiting asset selection");
    const work = state.work[itemId];
    if (!work || work.status !== "waiting" || work.step !== "approve-asset")
      throw new Error(`Work Item ${itemId} is not awaiting asset selection`);
    const set = work.assets?.find((candidate) => candidate.id === setId);
    if (!set) throw new Error(`AssetSet ${setId} is not a captured candidate`);
    const downstreamItems = [...new Set(decision?.downstreamItems ?? [])];
    for (const name of downstreamItems) {
      const dependent = state.graph.items.find((item) => item.id === name);
      if (
        !dependent ||
        !dependent.dependencies.includes(itemId) ||
        state.work[name]?.status !== "pending"
      )
        throw new Error(
          `Work Item ${name} is not a pending direct dependent of ${itemId}`,
        );
    }
    for (const member of set.members) await store.verify(member.ref);
    work.selectedAssetSet = setId;
    work.selectionDigest = assetSelectionDigest(set);
    work.selection = {
      actor: decision?.actor ?? userInfo().username,
      at: new Date().toISOString(),
      ...(decision?.reason && { reason: decision.reason }),
      destinations: set.members.map((member) => ({
        role: member.role,
        path: member.destination,
        digest: member.ref.digest,
      })),
      downstreamItems,
    };
    work.status = "running";
    saveState(statePath(config.repository, objective), state);
    new DiagnosticEmitter(config.repository, objective).emit({
      runId: state.runId,
      itemId,
      attemptId: work.attempt,
      operation: "media-selection",
      outcome: "completed",
      metadata: { setId, downstreamCount: downstreamItems.length },
    });
  } finally {
    releaseControllerLock(lock, lockHandle);
  }
}

export async function exportAssetSetForReview(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  setId: string,
  output: string,
  store: ContentStore,
): Promise<void> {
  const state = readState(config.repository, objective);
  const work = state?.work[itemId];
  if (!work || work.status !== "waiting" || work.step !== "approve-asset")
    throw new Error(`Work Item ${itemId} is not awaiting asset review`);
  const set = work.assets?.find((candidate) => candidate.id === setId);
  if (!set) throw new Error(`AssetSet ${setId} is not a captured candidate`);
  if (
    !isAbsolute(output) ||
    existsSync(output) ||
    resolve(output).startsWith(`${resolve(config.checkout)}${sep}`)
  )
    throw new Error(
      "Review output must be a new absolute directory outside the target checkout",
    );
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const member of set.members)
    await store.materialize(
      member.ref,
      join(output, `${member.role}-${basename(member.destination)}`),
    );
  new DiagnosticEmitter(config.repository, objective).emit({
    runId: state!.runId,
    itemId,
    attemptId: work.attempt,
    operation: "media-review-export",
    outcome: "completed",
    metadata: { setId, memberCount: set.members.length },
  });
}
