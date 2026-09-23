import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { LocalContentStore } from "../content/local.js";
import { captureAssetSets, importSourceAssets } from "../media.js";
import { parseProducedAssetSets } from "../media.js";
import {
  linuxProcessIdentity,
  pinnedGit,
  processGroupExists,
  sanitizedWorkerEnvironment,
} from "../process.js";

type Active = {
  request: ExecutionRequest;
  worktree: string;
  handle: HarnessHandle;
  failure?: string;
};

interface WorkerHandleData {
  pid: number;
  startTime: string;
  requestPath: string;
  resultPath: string;
  logPath: string;
}

export class CodexHarness implements AgentHarness {
  constructor(
    private credentialDirectory: string,
    private network: "host" | "off",
  ) {}

  async start(request: HarnessRequest): Promise<HarnessHandle> {
    const identity = request.attemptId ?? randomUUID();
    const root = join(dirname(this.credentialDirectory), "harness");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const requestPath = join(root, `${identity}.request.json`);
    const resultPath = join(root, `${identity}.result.json`);
    const logPath = join(root, `${identity}.log`);
    writeFileSync(
      requestPath,
      `${JSON.stringify({ request, network: this.network })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const log = openSync(logPath, "a", 0o600);
    let pid: number;
    try {
      const worker = fileURLToPath(new URL("./worker.js", import.meta.url));
      const child = spawn(process.execPath, [worker, requestPath, resultPath], {
        detached: true,
        stdio: ["ignore", log, log],
        env: sanitizedWorkerEnvironment(this.credentialDirectory),
      });
      if (!child.pid) throw new Error("Failed to launch Codex harness worker");
      pid = child.pid;
      child.unref();
    } finally {
      closeSync(log);
    }
    const identityOnHost = linuxProcessIdentity(pid);
    if (!identityOnHost || identityOnHost.group !== pid) {
      throw new Error(
        "Codex harness worker did not start in its own process group",
      );
    }
    return {
      identity,
      data: {
        pid,
        startTime: identityOnHost.startTime,
        requestPath,
        resultPath,
        logPath,
      } satisfies WorkerHandleData,
    };
  }

  async observe(handle: HarnessHandle): Promise<HarnessObservation> {
    const data = handle.data as WorkerHandleData;
    if (existsSync(data.resultPath)) {
      const result = JSON.parse(readFileSync(data.resultPath, "utf8")) as {
        state: "complete" | "failed";
        error?: string;
      };
      return result.state === "complete"
        ? { state: "complete" }
        : { state: "failed", detail: result.error };
    }
    const current = linuxProcessIdentity(data.pid);
    return current?.startTime === data.startTime &&
      current.group === data.pid &&
      current.state !== "Z"
      ? { state: "running" }
      : {
          state: "failed",
          detail:
            "Worker exited without a durable result; operator direction required",
        };
  }

  async cancel(handle: HarnessHandle): Promise<void> {
    const data = handle.data as WorkerHandleData;
    const current = linuxProcessIdentity(data.pid);
    if (current?.startTime !== data.startTime || current.group !== data.pid) {
      if (!existsSync(data.resultPath))
        throw new Error("Worker identity changed before cancellation");
      return;
    }
    try {
      process.kill(-data.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    while (processGroupExists(data.pid))
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }

  async collect(handle: HarnessHandle): Promise<HarnessResult> {
    const data = handle.data as WorkerHandleData;
    for (;;) {
      const observed = await this.observe(handle);
      if (observed.state === "running") {
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        continue;
      }
      if (observed.state !== "complete")
        throw new Error(observed.detail ?? "Codex harness worker failed");
      const result: unknown = JSON.parse(readFileSync(data.resultPath, "utf8"));
      if (!result || typeof result !== "object" || Array.isArray(result))
        throw new Error("Harness result is not an object");
      const value = result as Record<string, unknown>;
      if (
        value.state !== "complete" ||
        !value.evidence ||
        typeof value.evidence !== "object" ||
        Array.isArray(value.evidence)
      )
        throw new Error("Harness completion result lacks structured evidence");
      const assets =
        value.assets === undefined
          ? undefined
          : parseProducedAssetSets(value.assets);
      return { evidence: value.evidence, assets };
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

  private require(handle: ExecutionHandle): Active {
    const active =
      this.active.get(handle.identity) ?? (handle.data as Active | undefined);
    if (!active || handle.provider !== "local")
      throw new Error("Unknown local execution handle");
    return active;
  }

  constructor(
    private checkout: string,
    private workRoot: string,
    private harness: AgentHarness,
    private concurrency: number,
    private contentStore: LocalContentStore,
  ) {}

  async availableSlots(): Promise<number> {
    return Math.max(0, this.concurrency - this.active.size);
  }

  async start(request: ExecutionRequest): Promise<ExecutionHandle> {
    const identity = request.attemptId ?? randomUUID();
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
      const sourceAssets = await importSourceAssets(
        this.contentStore,
        worktree,
        request.item,
      );
      const handle = await this.harness.start({
        item: request.item,
        worktree,
        attemptId: identity,
        sourceAssets: sourceAssets.map((entry) => entry.ref),
      });
      const active = { request, worktree, handle };
      this.active.set(identity, active);
      return { provider: "local", identity, data: active };
    } catch (error) {
      pinnedGit(this.checkout, "worktree", "remove", "--force", worktree);
      throw error;
    }
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    const active = this.require(handle);
    return this.harness.observe(active.handle);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    const active = this.require(handle);
    await this.harness.cancel(active.handle);
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    const active = this.require(handle);
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
      const assets = await captureAssetSets(
        this.contentStore,
        active.worktree,
        active.request.item,
        result.assets ?? [],
        result.evidence,
      );
      rmSync(join(active.worktree, ".factory-assets.json"), { force: true });
      if (
        active.request.item.expectedOutputRoles?.length &&
        assets.length < (active.request.item.minimumAssetSets ?? 1)
      )
        throw new Error(
          "Media Work Item did not produce the requested AssetSets",
        );
      pinnedGit(active.worktree, "add", "-A");
      const paths = pinnedGit(
        active.worktree,
        "diff",
        "--cached",
        "--name-only",
      )
        .split("\n")
        .filter(Boolean);
      if (!paths.length && !assets.length)
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
      if (paths.length)
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
        assets,
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
