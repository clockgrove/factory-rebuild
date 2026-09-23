import { createHash, randomUUID } from "node:crypto";
import { readdirSync, existsSync, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
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
  resolvePlan,
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
import { git, linuxProcessIdentity } from "./process.js";
import { validateTree } from "./validation.js";
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
  const issue = await services.github.objective(objective);
  const baseSha = git(config.checkout, "rev-parse", "HEAD");
  return compilePlan(
    objective,
    issue.body,
    baseSha,
    config.checkout,
    services.planningModel,
  );
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
  const issue = await services.github.objective(objective);
  const baseSha = git(config.checkout, "rev-parse", "HEAD");
  return resolvePlan(
    candidate,
    objective,
    issue.body,
    baseSha,
    config.checkout,
    services.planningModel,
    input,
  );
}

function objectiveCommands(
  body: string,
  graph: FactoryState["graph"],
): string[] {
  const match = body.match(
    /^## Final validation\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im,
  );
  const declared = match?.[1]
    ?.split("\n")
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1])
    .filter((line): line is string => Boolean(line))
    .map((line) => line.replace(/^`|`$/g, ""));
  return declared?.length
    ? declared
    : [
        ...new Set(
          graph.items.flatMap((item) =>
            item.validation.map((check) => check.command),
          ),
        ),
      ];
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
  mkdirSync(root, { recursive: true });
  const lock = join(root, "controller.lock");
  const lockHandle = acquireControllerLock(lock, objective);
  const path = statePath(config.repository, objective);
  const active = new Map<string, Promise<void>>();
  const { driver, github, delivery, contentStore, planningModel } = services;
  let stateForSignal: FactoryState | undefined;
  let cancellationRequested = false;
  const onCancel = () => {
    cancellationRequested = true;
    if (stateForSignal) {
      stateForSignal.cancelRequested = true;
      saveState(path, stateForSignal);
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
      const save = () => saveState(path, state!);
      for (const item of state.graph.items)
        if (state.work[item.id]?.status === "done")
          await closeWorkItem(
            state,
            item.id,
            github,
            save,
            config.delivery.kind === "native-stack",
          );
      if (state.finalValidation?.passed) {
        await closeObjectiveIssue(state, issue.body, github, save);
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
      const plan =
        acceptedPlan ??
        (await compilePlan(
          objective,
          issue.body,
          baseSha,
          config.checkout,
          planningModel,
        ));
      verifyPlanCandidate(
        plan,
        objective,
        issue.body,
        baseSha,
        config.checkout,
      );
      if (acceptedPlan) {
        const freshReview = await planningModel.reviewGraph({
          objective: issue.body,
          baseSha,
          sources: plan.sources,
          graph: plan.graph,
        });
        if (freshReview.findings.length)
          throw new Error(
            `Accepted plan no longer passes independent review: ${freshReview.findings[0]!.question}`,
          );
      }
      const graph = plan.graph;
      const projected = await github.projectGraph({
        graph,
        objectiveIssue: objective,
      });
      state = {
        schemaVersion: 1,
        repository: config.repository,
        objective,
        runId: randomUUID(),
        configDigest,
        baseSha,
        graph,
        objectiveCommands: objectiveCommands(issue.body, graph),
        objectiveBodyDigest: createHash("sha256")
          .update(issue.body)
          .digest("hex"),
        issueByItemId: projected.issueByItemId,
        work: Object.fromEntries(
          graph.items.map((item) => [item.id, { status: "pending" }]),
        ),
      };
    }
    const graph = state.graph;
    stateForSignal = state;
    saveState(path, state);
    if (config.delivery.kind === "native-stack") {
      await runNativeGraph({
        config,
        objective,
        root,
        state,
        driver,
        delivery,
        contentStore,
        github,
        save: () => saveState(path, state),
        active,
        cancelled: () => cancellationRequested,
      });
      if (graph.items.some((item) => state.work[item.id]?.status === "waiting"))
        return state;
    } else {
      const awaitingSelection = await runRegularGraph({
        config,
        objective,
        root,
        state,
        driver,
        delivery,
        contentStore,
        github,
        save: () => saveState(path, state),
        active,
        cancelled: () => cancellationRequested,
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
    const finalEvidence = validateTree(
      config.checkout,
      join(root, "final-validation"),
      integratedSha,
      finalTree,
      objectiveCommands(issue.body, graph),
    );
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
    saveState(path, state);
    await closeObjectiveIssue(state, issue.body, github, () =>
      saveState(path, state),
    );
    return state;
  } catch (error) {
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
      saveState(path, state);
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
  } finally {
    releaseControllerLock(lock, lockHandle);
  }
}

export async function selectAssetSet(
  config: FactoryConfig,
  objective: number,
  itemId: string,
  setId: string,
  store: ContentStore,
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
    for (const member of set.members) await store.verify(member.ref);
    work.selectedAssetSet = setId;
    work.selectionDigest = assetSelectionDigest(set);
    work.status = "running";
    saveState(statePath(config.repository, objective), state);
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
}
