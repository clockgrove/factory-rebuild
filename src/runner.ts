import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  readdirSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { FactoryConfig } from "./config.js";
import { stateRoot, validateTarget } from "./config.js";
import type { FactoryState } from "./state.js";
import type { WorkItem } from "./contracts.js";
import { compileObjective } from "./compiler.js";
import { RealGitHubGateway } from "./github.js";
import { CodexHarness, LocalExecutionDriver } from "./execution/local.js";
import { RegularDelivery } from "./delivery/regular.js";
import { git, linuxProcessIdentity } from "./process.js";
import { validateTree, validateWorkItem } from "./validation.js";
import { readyItems } from "./scheduler.js";

function statePath(repository: string, objective: number): string {
  return join(
    stateRoot(repository),
    "objectives",
    String(objective),
    "state.json",
  );
}

function save(path: string, state: FactoryState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

function acquireControllerLock(
  path: string,
  objective: number,
): { fd: number; token: string } {
  const token = randomUUID();
  try {
    const previous = JSON.parse(readFileSync(path, "utf8")) as {
      pid: number;
      startTime: string;
    };
    const current = linuxProcessIdentity(previous.pid);
    if (current?.startTime === previous.startTime && current.state !== "Z") {
      throw new Error("A Factory controller already owns this installation");
    }
    rmSync(path);
  } catch (error) {
    if (error instanceof Error && error.message.includes("already owns"))
      throw error;
    if (existsSync(path)) rmSync(path);
  }
  const fd = openSync(path, "wx", 0o600);
  const identity = linuxProcessIdentity(process.pid);
  writeFileSync(
    fd,
    JSON.stringify({
      pid: process.pid,
      startTime: identity?.startTime,
      token,
      objective,
    }),
  );
  fsyncSync(fd);
  return { fd, token };
}

export function readState(
  repository: string,
  objective: number,
): FactoryState | undefined {
  const path = statePath(repository, objective);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as FactoryState)
    : undefined;
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
): Promise<FactoryState> {
  validateTarget(config.repository, config.checkout);
  if (config.execution.kind !== "local" || config.delivery.kind !== "regular") {
    throw new Error(
      "Current trunk supports local execution and regular delivery only",
    );
  }
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true });
  const lock = join(root, "controller.lock");
  const lockHandle = acquireControllerLock(lock, objective);
  const path = statePath(config.repository, objective);
  const active = new Map<string, Promise<void>>();
  let driver: LocalExecutionDriver | undefined;
  let stateForSignal: FactoryState | undefined;
  let cancellationRequested = false;
  const onCancel = () => {
    cancellationRequested = true;
    if (stateForSignal) {
      stateForSignal.cancelRequested = true;
      save(path, stateForSignal);
    }
    if (driver && stateForSignal) {
      for (const id of active.keys()) {
        const handle = stateForSignal.work[id]?.execution;
        if (handle) void driver.cancel(handle).catch(() => undefined);
      }
    }
  };
  process.on("SIGUSR1", onCancel);
  try {
    const github = new RealGitHubGateway(config.repository);
    const issue = github.objective(objective);
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
      if (state.error)
        throw new Error(
          `Objective stopped: ${state.error}. Use explicit retry or operator direction.`,
        );
      if (state.finalValidation?.passed) return state;
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
      const graph = await compileObjective(
        objective,
        issue.body,
        baseSha,
        config.checkout,
      );
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
        issueByItemId: projected.issueByItemId,
        work: Object.fromEntries(
          graph.items.map((item) => [item.id, { status: "pending" }]),
        ),
      };
    }
    const graph = state.graph;
    stateForSignal = state;
    const baseSha = state.baseSha;
    const projected = { issueByItemId: state.issueByItemId };
    save(path, state);
    const credentials = join(root, "empty-gh-config");
    mkdirSync(credentials, { recursive: true, mode: 0o700 });
    driver = new LocalExecutionDriver(
      config.checkout,
      join(root, "worktrees"),
      new CodexHarness(credentials, config.policy.network),
      config.execution.concurrency,
    );
    const commits = new Map<string, string>();
    const delivery = new RegularDelivery(config.checkout, github, commits);
    let mergeTail: Promise<void> = Promise.resolve();
    const execute = async (
      item: WorkItem,
      itemBase: string,
      existingHandle?: NonNullable<FactoryState["work"][string]["execution"]>,
    ): Promise<void> => {
      const work = state.work[item.id]!;
      try {
        const handle =
          existingHandle ??
          (await driver!.start({
            item,
            baseSha: itemBase,
            attemptId: work.attempt,
          }));
        if (!existingHandle) {
          work.execution = handle;
          save(path, state);
        }
        if (cancellationRequested) {
          await driver!.cancel(handle);
          throw new Error("Objective cancelled");
        }
        const result = await driver!.collect(handle);
        if (cancellationRequested) throw new Error("Objective cancelled");
        work.treeSha = result.treeSha;
        work.step = "validate";
        save(path, state);
        work.validation = validateWorkItem(
          config.checkout,
          join(root, "validation"),
          item,
          result.changeRef,
          result.treeSha,
        );
        work.step = "deliver";
        save(path, state);
        commits.set(result.treeSha, result.changeRef);
        const branch = `factory/objective-${objective}/${item.id}`;
        const published = await delivery.publish({
          item,
          baseSha: itemBase,
          treeSha: result.treeSha,
          branch,
        });
        work.pullRequest = published.pullRequest;
        save(path, state);
        const integrate = mergeTail.then(async () => {
          const merged = await delivery.merge(published);
          git(config.checkout, "fetch", "origin", github.defaultBranch());
          const observedHead = git(config.checkout, "rev-parse", "FETCH_HEAD");
          if (observedHead !== merged.integratedSha) {
            throw new Error(
              `Default branch moved after PR #${published.pullRequest} merged; expected ${merged.integratedSha}, observed ${observedHead}`,
            );
          }
          state.integratedSha = observedHead;
          work.status = "done";
          work.completedAt = new Date().toISOString();
          delete work.step;
          save(path, state);
        });
        mergeTail = integrate.then(
          () => undefined,
          () => undefined,
        );
        await integrate;
        github.closeIssue(
          projected.issueByItemId[item.id]!,
          `Completed by PR #${published.pullRequest}; validated tree ${result.treeSha}.`,
        );
      } catch (error) {
        if (work.status !== "done")
          work.status = cancellationRequested ? "cancelled" : "failed";
        work.error = error instanceof Error ? error.message : String(error);
        save(path, state);
        throw error;
      }
    };
    for (const item of graph.items) {
      const work = state.work[item.id]!;
      if (work.status !== "running") continue;
      if (work.step !== "execute" || !work.execution || !work.baseSha) {
        throw new Error(
          `Work Item ${item.id} has ambiguous active state at ${work.step ?? "unknown"}; operator direction required`,
        );
      }
      const promise = execute(item, work.baseSha, work.execution).finally(
        () => {
          active.delete(item.id);
        },
      );
      void promise.catch(() => undefined);
      active.set(item.id, promise);
    }
    while (graph.items.some((item) => state.work[item.id]?.status !== "done")) {
      if (cancellationRequested) throw new Error("Objective cancelled");
      const available = await driver.availableSlots();
      const slots = Math.min(
        config.execution.concurrency - active.size,
        available,
      );
      const ready = readyItems(
        graph,
        state.work,
        new Set(active.keys()),
        slots,
      );
      for (const item of ready) {
        const work = state.work[item.id]!;
        work.status = "running";
        work.step = "execute";
        work.attempt = randomUUID();
        work.startedAt = new Date().toISOString();
        const itemBase = state.integratedSha ?? baseSha;
        work.baseSha = itemBase;
        save(path, state);
        const promise = execute(item, itemBase).finally(() => {
          active.delete(item.id);
        });
        void promise.catch(() => undefined);
        active.set(item.id, promise);
      }
      if (!active.size)
        throw new Error("No ready Work Item; graph cannot progress");
      await Promise.race(active.values());
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
    state.finalValidation = {
      ...validateTree(
        config.checkout,
        join(root, "final-validation"),
        integratedSha,
        finalTree,
        objectiveCommands(issue.body, graph),
      ),
      passed: true,
    };
    save(path, state);
    github.closeIssue(
      objective,
      `Factory completed ${graph.items.length} Work Items; final validation passed at ${integratedSha}.`,
    );
    return state;
  } catch (error) {
    if (driver) {
      for (const item of active.keys()) {
        const handle = readState(config.repository, objective)?.work[item]
          ?.execution;
        if (handle) await driver.cancel(handle).catch(() => undefined);
      }
      await Promise.allSettled(active.values());
    }
    if (existsSync(path)) {
      const state = readState(config.repository, objective)!;
      if (cancellationRequested || state.cancelRequested) {
        state.cancelRequested = true;
        state.cancelledAt = new Date().toISOString();
        for (const work of Object.values(state.work))
          if (work.status === "running" || work.status === "pending")
            work.status = "cancelled";
      } else {
        state.error = error instanceof Error ? error.message : String(error);
      }
      save(path, state);
    }
    throw error;
  } finally {
    process.off("SIGUSR1", onCancel);
    closeSync(lockHandle.fd);
    try {
      const current = JSON.parse(readFileSync(lock, "utf8")) as {
        token?: string;
      };
      if (current.token === lockHandle.token) rmSync(lock);
    } catch {
      // A missing lock needs no cleanup.
    }
  }
}

export async function cancelObjective(
  config: FactoryConfig,
  objective: number,
): Promise<"requested" | "cancelled"> {
  const root = stateRoot(config.repository);
  const lock = join(root, "controller.lock");
  try {
    const owner = JSON.parse(readFileSync(lock, "utf8")) as {
      pid: number;
      startTime: string;
      objective?: number;
    };
    const current = linuxProcessIdentity(owner.pid);
    if (current?.startTime === owner.startTime && current.state !== "Z") {
      if (owner.objective !== objective)
        throw new Error(`Controller is running Objective #${owner.objective}`);
      process.kill(owner.pid, "SIGUSR1");
      return "requested";
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Controller is running")
    )
      throw error;
    // An invalid or stale lock is reconciled by acquireControllerLock.
  }
  const lockHandle = acquireControllerLock(lock, objective);
  try {
    const state = readState(config.repository, objective);
    if (!state) throw new Error("Objective has no Factory state");
    if (state.finalValidation?.passed || state.cancelledAt) return "cancelled";
    if (config.execution.kind !== "local")
      throw new Error("Unsupported execution mode");
    const credentials = join(root, "empty-gh-config");
    const driver = new LocalExecutionDriver(
      config.checkout,
      join(root, "worktrees"),
      new CodexHarness(credentials, config.policy.network),
      config.execution.concurrency,
    );
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
    save(statePath(config.repository, objective), state);
    return "cancelled";
  } finally {
    closeSync(lockHandle.fd);
    rmSync(lock, { force: true });
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
    if (work.pullRequest)
      throw new Error("Published PR requires operator direction before retry");
    state.work[itemId] = { status: "pending" };
    state.cancelRequested = false;
    delete state.cancelledAt;
    delete state.error;
    save(statePath(config.repository, objective), state);
  } finally {
    closeSync(lockHandle.fd);
    rmSync(lock, { force: true });
  }
}
