import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  AgentHarness,
  ExecutionDriver,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionRequest,
  ExecutionResult,
  HarnessHandle,
  HarnessObservation,
  HarnessRequest,
  HarnessResult,
} from "../contracts.js";
import { pinnedGit, sanitizedWorkerEnvironment } from "../process.js";

type Active = {
  request: ExecutionRequest;
  worktree: string;
  handle: HarnessHandle;
  failure?: string;
};

export class CodexHarness implements AgentHarness {
  private active = new Map<
    string,
    {
      signal: AbortController;
      promise: Promise<HarnessResult>;
      state: HarnessObservation;
    }
  >();

  constructor(
    private credentialDirectory: string,
    private network: "host" | "off",
  ) {}

  async start(request: HarnessRequest): Promise<HarnessHandle> {
    const identity = randomUUID();
    const signal = new AbortController();
    const state: HarnessObservation = { state: "running" };
    const codex = new Codex({
      env: sanitizedWorkerEnvironment(this.credentialDirectory),
    });
    const thread = codex.startThread({
      workingDirectory: request.worktree,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      networkAccessEnabled: this.network === "host",
    });
    const prompt = `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${request.item.title}\nGoal: ${request.item.goal}\nAcceptance:\n${request.item.acceptance.join("\n")}\nOwned paths:\n${request.item.ownedPaths.join("\n")}\nBrief:\n${request.item.brief}`;
    const promise = thread
      .run(prompt, { signal: signal.signal })
      .then((result) => {
        state.state = "complete";
        return {
          evidence: {
            finalResponse: result.finalResponse,
            threadId: thread.id,
            usage: result.usage,
          },
        };
      })
      .catch((error: unknown) => {
        state.state = signal.signal.aborted ? "cancelled" : "failed";
        state.detail = error instanceof Error ? error.message : String(error);
        throw error;
      });
    void promise.catch(() => undefined);
    this.active.set(identity, { signal, promise, state });
    return { identity };
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    const active = this.active.get(handle.identity);
    if (!active) throw new Error("Unknown harness handle");
    return { ...active.state };
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const active = this.active.get(handle.identity);
    if (!active) throw new Error("Unknown harness handle");
    active.signal.abort();
  }

  async collect(handle: HarnessHandle): Promise<HarnessResult> {
    const active = this.active.get(handle.identity);
    if (!active) throw new Error("Unknown harness handle");
    try {
      return await active.promise;
    } finally {
      this.active.delete(handle.identity);
    }
  }
}

function owns(path: string, owned: string[]): boolean {
  return owned.some((scope) =>
    scope.endsWith("/") ? path.startsWith(scope) : path === scope,
  );
}

export class LocalExecutionDriver implements ExecutionDriver {
  private active = new Map<string, Active>();

  constructor(
    private checkout: string,
    private workRoot: string,
    private harness: AgentHarness,
    private concurrency: number,
  ) {}

  async availableSlots(): Promise<number> {
    return Math.max(0, this.concurrency - this.active.size);
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const identity = randomUUID();
    const worktree = join(this.workRoot, identity);
    mkdirSync(this.workRoot, { recursive: true });
    const verified = pinnedGit(
      this.checkout,
      "rev-parse",
      "--verify",
      `${request.baseSha}^{commit}`,
    );
    if (verified !== request.baseSha)
      throw new Error("Execution base does not resolve exactly");
    pinnedGit(
      this.checkout,
      "worktree",
      "add",
      "--detach",
      worktree,
      request.baseSha,
    );
    try {
      const handle = await this.harness.start({
        item: request.item,
        worktree,
        sourceAssets: request.sourceAssets,
      });
      this.active.set(identity, { request, worktree, handle });
      return { provider: "local", identity };
    } catch (error) {
      pinnedGit(this.checkout, "worktree", "remove", "--force", worktree);
      throw error;
    }
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    const active = this.active.get(handle.identity);
    if (!active) throw new Error("Unknown local execution handle");
    return this.harness.observe(active.handle);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const active = this.active.get(handle.identity);
    if (!active) throw new Error("Unknown local execution handle");
    await this.harness.cancel(active.handle);
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    const active = this.active.get(handle.identity);
    if (!active) throw new Error("Unknown local execution handle");
    try {
      const result = await this.harness.collect(active.handle);
      if (
        pinnedGit(active.worktree, "rev-parse", "HEAD") !==
        active.request.baseSha
      ) {
        throw new Error(
          "Worker changed HEAD; expected uncommitted changes at exact base",
        );
      }
      pinnedGit(active.worktree, "add", "-A");
      const paths = pinnedGit(
        active.worktree,
        "diff",
        "--cached",
        "--name-only",
      )
        .split("\n")
        .filter(Boolean);
      if (!paths.length)
        throw new Error("Worker produced no repository change");
      if (!paths.every((path) => owns(path, active.request.item.ownedPaths))) {
        throw new Error(
          `Worker changed paths outside ownership: ${paths.filter((path) => !owns(path, active.request.item.ownedPaths)).join(", ")}`,
        );
      }
      const staged = pinnedGit(active.worktree, "ls-files", "--stage");
      if (
        staged
          .split("\n")
          .some(
            (line) => line.startsWith("120000 ") || line.startsWith("160000 "),
          )
      ) {
        throw new Error("Worker result contains a symlink or submodule");
      }
      if (readdirSync(active.worktree).includes(".gitmodules"))
        throw new Error("Worker result contains submodules");
      pinnedGit(
        active.worktree,
        "-c",
        "user.name=Factory",
        "-c",
        "user.email=factory@users.noreply.github.com",
        "commit",
        "-m",
        `Factory: ${active.request.item.title}`,
      );
      const commit = pinnedGit(active.worktree, "rev-parse", "HEAD");
      const treeSha = pinnedGit(active.worktree, "rev-parse", "HEAD^{tree}");
      return {
        changeRef: commit,
        treeSha,
        evidence: result.evidence,
        assets: result.assets,
      };
    } finally {
      this.active.delete(handle.identity);
      try {
        pinnedGit(
          this.checkout,
          "worktree",
          "remove",
          "--force",
          active.worktree,
        );
      } catch {
        rmSync(active.worktree, { recursive: true, force: true });
      }
    }
  }
}
