import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentHarness,
  ContentStore,
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
import { captureAssetSets, importSourceAssets } from "../media.js";
import { parseProducedAssetSets } from "../media.js";
import {
  linuxProcessIdentity,
  pinnedGit,
  pinnedGitEnvironment,
  pinnedGitRaw,
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
    private allowedSecretNames: string[] = [],
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
        env: sanitizedWorkerEnvironment(
          this.credentialDirectory,
          this.allowedSecretNames,
        ),
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

function inside(path: string, directory: string): boolean {
  const root = resolve(directory);
  const candidate = resolve(path);
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function changedPaths(worktree: string): string[] {
  const output = pinnedGitRaw(
    worktree,
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    "HEAD",
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

function stagedEntry(
  worktree: string,
  path: string,
): { mode: string; blob: string } | null {
  const output = pinnedGitRaw(
    worktree,
    "ls-files",
    "--stage",
    "-z",
    "--",
    path,
  );
  if (!output.length) return null;
  const line = output.toString("utf8");
  const match = /^(\d{6}) ([a-f0-9]{40,64}) 0\t([^\0]*)\0$/.exec(line);
  if (!match || match[3] !== path)
    throw new Error(`Cannot verify staged entry at ${JSON.stringify(path)}`);
  return { mode: match[1]!, blob: match[2]! };
}

function checkChangedPath(worktree: string, path: string): void {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path
      .split("/")
      .some(
        (component) => !component || component === "." || component === "..",
      )
  )
    throw new Error(`Worker changed unsafe path ${JSON.stringify(path)}`);
  const destination = resolve(worktree, path);
  if (!inside(destination, worktree))
    throw new Error(
      `Worker changed path outside worktree: ${JSON.stringify(path)}`,
    );
  let current = worktree;
  for (const component of path.split("/")) {
    current = join(current, component);
    let type;
    try {
      type = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (type.isSymbolicLink() || (!type.isFile() && !type.isDirectory()))
      throw new Error(
        `Worker changed unsafe filesystem entry at ${JSON.stringify(path)}`,
      );
  }
  if (existsSync(destination) && !inside(realpathSync(destination), worktree))
    throw new Error(
      `Worker changed path escaping worktree: ${JSON.stringify(path)}`,
    );
}

/** A Git tree cannot contain special files; any such entry appeared during this attempt. */
function checkWorktreeEntries(worktree: string): void {
  const inspect = (directory: string, relative: string): void => {
    for (const name of readdirSync(directory)) {
      if (!relative && name === ".git") continue;
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(directory, name);
      const type = lstatSync(absolute);
      if (type.isDirectory()) {
        inspect(absolute, path);
      } else if (type.isSymbolicLink()) {
        const base = pinnedGitRaw(
          worktree,
          "ls-tree",
          "HEAD",
          "--",
          path,
        ).toString("utf8");
        if (
          !base.startsWith("120000 blob\t") &&
          !base.startsWith("120000 blob ")
        )
          throw new Error(
            `Worker introduced unsafe symlink at ${JSON.stringify(path)}`,
          );
      } else if (!type.isFile()) {
        throw new Error(
          `Worker introduced special file at ${JSON.stringify(path)}`,
        );
      }
    }
  };
  inspect(worktree, "");
}

const require = createRequire(import.meta.url);
const secretlint = join(
  dirname(require.resolve("secretlint/package.json")),
  "bin",
  "secretlint.js",
);
const recommendedRules = JSON.stringify({
  rules: [{ id: "@secretlint/secretlint-rule-preset-recommend" }],
});

function scanChangedFile(
  worktree: string,
  path: string,
  source: string,
  report: string,
  checkout: string,
): void {
  const config = process.env.FACTORY_SECRETLINT_CONFIG;
  if (
    config &&
    (!isAbsolute(config) ||
      inside(config, checkout) ||
      inside(config, worktree) ||
      !lstatSync(config).isFile() ||
      inside(realpathSync(config), checkout) ||
      inside(realpathSync(config), worktree))
  )
    throw new Error(
      "FACTORY_SECRETLINT_CONFIG must be a regular absolute file outside the target checkout",
    );
  const args = [
    secretlint,
    "--no-glob",
    source,
    "--format=compact",
    "--no-gitignore",
    "--secretlintignore=/dev/null",
    `--secretlintrcJSON=${config ? readFileSync(config, "utf8") : recommendedRules}`,
  ];
  const output = openSync(report, "w", 0o600);
  let result;
  try {
    result = spawnSync(process.execPath, args, {
      cwd: worktree,
      stdio: ["ignore", output, output],
      env: sanitizedWorkerEnvironment(
        join(dirname(worktree), "empty-gh-config"),
      ),
    });
  } finally {
    closeSync(output);
  }
  if (result.error || ![0, 1].includes(result.status ?? -1))
    throw new Error(
      `Secretlint could not check ${JSON.stringify(path)}; publication stopped`,
    );
  if (result.status === 1) {
    const fd = openSync(report, "r");
    const excerpt = Buffer.alloc(8192);
    let count: number;
    try {
      count = readSync(fd, excerpt, 0, excerpt.length, 0);
    } finally {
      closeSync(fd);
    }
    const rules = [
      ...excerpt
        .subarray(0, count)
        .toString("utf8")
        .matchAll(/@secretlint\/secretlint-rule-[A-Za-z0-9-]+/g),
    ].map((match) => match[0]);
    throw new Error(
      `Secretlint found suspected secret in ${JSON.stringify(path)} (${rules.at(-1) ?? "Secretlint recommended rules"}). Publication stopped. Operator: review the finding; remove or rotate the value, or supply a reviewed Secretlint config outside the target checkout via FACTORY_SECRETLINT_CONFIG and explicitly retry.`,
    );
  }
}

/** Guard the staged candidate before any controller-side publication or upload. */
export function checkStagedCandidate(
  worktree: string,
  checkout: string,
  ownedPaths: string[],
): string[] {
  checkWorktreeEntries(worktree);
  const paths = changedPaths(worktree);
  const unowned = paths.filter((path) => !owns(path, ownedPaths));
  if (unowned.length)
    throw new Error(
      `Worker changed paths outside ownership: ${unowned.join(", ")}`,
    );
  for (const path of paths) {
    checkChangedPath(worktree, path);
    const entry = stagedEntry(worktree, path);
    if (!entry) continue; // Deletion has no new content to publish.
    if (path === ".gitmodules" || !["100644", "100755"].includes(entry.mode))
      throw new Error(
        `Worker changed unsafe Git entry at ${JSON.stringify(path)}`,
      );
    const scanRoot = mkdtempSync(join(dirname(worktree), "secret-scan-"));
    try {
      const staged = join(scanRoot, "content", path);
      mkdirSync(dirname(staged), { recursive: true, mode: 0o700 });
      const output = openSync(staged, "wx", 0o600);
      let copy;
      try {
        copy = spawnSync(
          "git",
          ["-C", worktree, "cat-file", "blob", entry.blob],
          {
            env: pinnedGitEnvironment(),
            stdio: ["ignore", output, "ignore"],
          },
        );
      } finally {
        closeSync(output);
      }
      if (copy.error || copy.status !== 0)
        throw new Error(
          `Cannot read staged content at ${JSON.stringify(path)}`,
        );
      const report = join(scanRoot, "report.txt");
      scanChangedFile(worktree, path, staged, report, checkout);
      if (
        pinnedGit(worktree, "hash-object", "--no-filters", "--", path) !==
        entry.blob
      )
        scanChangedFile(worktree, path, join(worktree, path), report, checkout);
    } finally {
      rmSync(scanRoot, { recursive: true, force: true });
    }
  }
  return paths;
}

export class LocalExecutionDriver implements ExecutionDriver {
  private active = new Map<string, Active>();

  private require(handle: ExecutionHandle): Active {
    const active =
      this.active.get(handle.identity) ?? (handle.data as Active | undefined);
    if (!active || handle.provider !== "local")
      throw new Error("Unknown local execution handle");
    if (
      !resolve(active.worktree).startsWith(`${resolve(this.workRoot)}${sep}`) ||
      active.request.attemptId !== handle.identity
    )
      throw new Error("Local execution handle is outside owned state");
    return active;
  }

  constructor(
    private checkout: string,
    private workRoot: string,
    private harness: AgentHarness,
    private concurrency: number,
    private contentStore: ContentStore,
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
        sourceAssets,
      });
      const active = {
        request: { ...request, sourceAssets },
        worktree,
        handle,
      };
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
        active.request.sourceAssets,
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
      const paths = checkStagedCandidate(
        active.worktree,
        this.checkout,
        active.request.item.ownedPaths,
      );
      if (!paths.length && !assets.length)
        throw new Error("Worker produced no repository change");
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
