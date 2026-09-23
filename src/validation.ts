import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { WorkItem } from "./contracts.js";
import { pinnedGit, sanitizedWorkerEnvironment } from "./process.js";

export interface ValidationEvidence {
  treeSha: string;
  commands: { command: string; passed: true }[];
}

export interface ValidationObservation {
  index: number;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  output: string;
}

export function validateTree(
  checkout: string,
  root: string,
  commit: string,
  expectedTree: string,
  commands: string[],
  observe?: (entry: ValidationObservation) => void,
): ValidationEvidence {
  mkdirSync(root, { recursive: true });
  const emptyCredentials = join(root, "empty-gh-config");
  mkdirSync(emptyCredentials, { recursive: true, mode: 0o700 });
  const worktree = join(root, randomUUID());
  pinnedGit(checkout, "worktree", "add", "--detach", worktree, commit);
  try {
    const treeSha = pinnedGit(worktree, "rev-parse", "HEAD^{tree}");
    if (treeSha !== expectedTree)
      throw new Error(
        `Validation tree mismatch: expected ${expectedTree}, got ${treeSha}`,
      );
    const evidence: ValidationEvidence = { treeSha, commands: [] };
    for (const [index, check] of commands.entries()) {
      const started = Date.now();
      const result = spawnSync("sh", ["-lc", check], {
        cwd: worktree,
        env: sanitizedWorkerEnvironment(emptyCredentials),
        encoding: "utf8",
        maxBuffer: Number.MAX_SAFE_INTEGER,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      observe?.({
        index,
        passed: !result.error && result.status === 0,
        exitCode: result.status ?? -1,
        durationMs: Date.now() - started,
        output,
      });
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(
          `Validation command failed (${result.status}): ${check}: ${output}`,
        );
      evidence.commands.push({ command: check, passed: true });
    }
    if (pinnedGit(worktree, "status", "--porcelain"))
      throw new Error("Validation command modified the result tree");
    return evidence;
  } finally {
    try {
      pinnedGit(checkout, "worktree", "remove", "--force", worktree);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

export function validateWorkItem(
  checkout: string,
  root: string,
  item: WorkItem,
  commit: string,
  treeSha: string,
  observe?: (entry: ValidationObservation) => void,
): ValidationEvidence {
  return validateTree(
    checkout,
    root,
    commit,
    treeSha,
    item.validation.map((v) => v.command),
    observe,
  );
}
