import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
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
import { compileObjective } from "./compiler.js";
import { RealGitHubGateway } from "./github.js";
import { CodexHarness, LocalExecutionDriver } from "./execution/local.js";
import { RegularDelivery } from "./delivery/regular.js";
import { git } from "./process.js";
import { validateTree, validateWorkItem } from "./validation.js";

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

export function readState(
  repository: string,
  objective: number,
): FactoryState | undefined {
  const path = statePath(repository, objective);
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as FactoryState)
    : undefined;
}

export async function runObjective(
  config: FactoryConfig,
  objective: number,
): Promise<FactoryState> {
  validateTarget(config.repository, config.checkout);
  if (config.execution.kind !== "local" || config.delivery.kind !== "regular") {
    throw new Error(
      "Slice 1 supports local execution and regular delivery only",
    );
  }
  const root = stateRoot(config.repository);
  mkdirSync(root, { recursive: true });
  const lock = join(root, "controller.lock");
  const fd = openSync(lock, "wx", 0o600);
  const path = statePath(config.repository, objective);
  try {
    if (existsSync(path))
      throw new Error(
        "Objective already has a run; restart support begins in Slice 2",
      );
    const github = new RealGitHubGateway(config.repository);
    const issue = github.objective(objective);
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
    const runId = randomUUID();
    const item = graph.items[0]!;
    const state: FactoryState = {
      schemaVersion: 1,
      repository: config.repository,
      objective,
      runId,
      configDigest: createHash("sha256")
        .update(JSON.stringify(config))
        .digest("hex"),
      baseSha,
      graph,
      issueByItemId: projected.issueByItemId,
      work: { [item.id]: { status: "pending" } },
    };
    save(path, state);
    const work = state.work[item.id]!;
    const credentials = join(root, "empty-gh-config");
    mkdirSync(credentials, { recursive: true, mode: 0o700 });
    const driver = new LocalExecutionDriver(
      config.checkout,
      join(root, "worktrees"),
      new CodexHarness(credentials, config.policy.network),
      1,
    );
    work.status = "running";
    work.step = "execute";
    work.attempt = randomUUID();
    save(path, state);
    const handle = await driver.start({ item, baseSha });
    work.execution = handle;
    save(path, state);
    const result = await driver.collect(handle);
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
    save(path, state);
    work.step = "deliver";
    save(path, state);
    const commits = new Map([[result.treeSha, result.changeRef]]);
    const delivery = new RegularDelivery(config.checkout, github, commits);
    const branch = `factory/objective-${objective}/${item.id}`;
    const published = await delivery.publish({
      item,
      baseSha,
      treeSha: result.treeSha,
      branch,
    });
    work.pullRequest = published.pullRequest;
    save(path, state);
    const merged = await delivery.merge(published);
    work.status = "done";
    delete work.step;
    state.integratedSha = merged.integratedSha;
    save(path, state);
    git(config.checkout, "fetch", "origin", github.defaultBranch());
    const finalTree = git(
      config.checkout,
      "rev-parse",
      `${merged.integratedSha}^{tree}`,
    );
    const finalEvidence = validateTree(
      config.checkout,
      join(root, "final-validation"),
      merged.integratedSha,
      finalTree,
      item.validation.map((v) => v.command),
    );
    state.finalValidation = { ...finalEvidence, passed: true };
    save(path, state);
    github.closeIssue(
      projected.issueByItemId[item.id]!,
      `Completed by PR #${published.pullRequest}; validated tree ${result.treeSha}.`,
    );
    github.closeIssue(
      objective,
      `Factory completed Work Item #${projected.issueByItemId[item.id]} through PR #${published.pullRequest}; final validation passed at ${merged.integratedSha}.`,
    );
    return state;
  } catch (error) {
    if (existsSync(path)) {
      const state = readState(config.repository, objective)!;
      const running = Object.values(state.work).find(
        (work) => work.status === "running",
      );
      if (running) {
        running.status = "failed";
        running.error = error instanceof Error ? error.message : String(error);
      }
      state.error = error instanceof Error ? error.message : String(error);
      save(path, state);
    }
    throw error;
  } finally {
    closeSync(fd);
    rmSync(lock, { force: true });
  }
}
