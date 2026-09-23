import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { PlanningModel, WorkItem } from "./contracts.js";
import { pinnedGit, sanitizedWorkerEnvironment } from "./process.js";

export interface CriterionEvidence {
  criterion: string;
  verdict: "pass" | "human-accept";
  source: string;
  quote: string;
  detail: string;
}

export interface AcceptanceDecision {
  criterion: string;
  treeSha: string;
  actor: string;
  at: string;
  outcome: "accept" | "refuse";
  reason: string;
}

export class AcceptanceDecisionRequired extends Error {
  constructor(
    public readonly pending: {
      criterion: string;
      treeSha: string;
      source: string;
      quote: string;
      question: string;
      detail: string;
    },
  ) {
    super(
      `Acceptance decision required for ${pending.criterion}: ${pending.question}`,
    );
  }
}

export interface ValidationEvidence {
  treeSha: string;
  commands: { command: string; passed: true }[];
  criteria?: CriterionEvidence[];
}

/** A separate read-only review evaluates each criterion on a bounded exact-tree packet. */
export async function reviewAcceptance(args: {
  model: PlanningModel;
  checkout: string;
  baseSha: string;
  commit: string;
  evidence: ValidationEvidence;
  criteria: string[];
  sources: { path: string; content: string }[];
  decisions?: AcceptanceDecision[];
  observations?: string;
}): Promise<ValidationEvidence> {
  const { model, checkout, baseSha, commit, evidence, criteria, sources } =
    args;
  if (!criteria.length) throw new Error("No acceptance criteria to prove");
  const observedTree = pinnedGit(checkout, "rev-parse", `${commit}^{tree}`);
  if (observedTree !== evidence.treeSha)
    throw new Error("Acceptance result tree differs from command evidence");
  const change = pinnedGit(
    checkout,
    "diff",
    "--no-ext-diff",
    "--binary",
    baseSha,
    commit,
    "--",
  );
  const bounded = Buffer.byteLength(change, "utf8") <= 100_000;
  let findings: Awaited<
    ReturnType<NonNullable<PlanningModel["reviewResult"]>>
  >["findings"] = [];
  if (bounded && model.reviewResult) {
    try {
      findings = (
        await model.reviewResult({
          criteria,
          baseSha,
          treeSha: evidence.treeSha,
          sources,
          change,
          commands: evidence.commands,
          ...(args.observations ? { observations: args.observations } : {}),
        })
      ).findings;
    } catch {
      findings = [];
    }
  }
  const valid =
    findings.length === criteria.length &&
    findings.every(
      (finding, index) =>
        finding.criterion === criteria[index] &&
        ["pass", "needs-human", "refuse"].includes(finding.verdict) &&
        Boolean(finding.detail?.trim()) &&
        sources.some(
          (source) =>
            source.path === finding.source &&
            Boolean(finding.quote?.trim()) &&
            source.content.includes(finding.quote),
        ),
    );
  const proven: CriterionEvidence[] = [];
  for (const [index, criterion] of criteria.entries()) {
    const decision = args.decisions?.find(
      (item) =>
        item.criterion === criterion && item.treeSha === evidence.treeSha,
    );
    if (decision?.outcome === "refuse")
      throw new Error(
        `Acceptance criterion refused by ${decision.actor}: ${criterion}`,
      );
    if (decision?.outcome === "accept") {
      proven.push({
        criterion,
        verdict: "human-accept",
        source: "OPERATOR",
        quote: decision.reason,
        detail: `${decision.actor} at ${decision.at}`,
      });
      continue;
    }
    const finding = valid ? findings[index] : undefined;
    if (finding?.verdict === "pass") {
      proven.push({
        criterion,
        verdict: "pass",
        source: finding.source,
        quote: finding.quote,
        detail: finding.detail,
      });
      continue;
    }
    if (finding?.verdict === "refuse")
      throw new Error(
        `Acceptance criterion disproved: ${criterion}: ${finding.detail}`,
      );
    throw new AcceptanceDecisionRequired({
      criterion,
      treeSha: evidence.treeSha,
      source: finding?.source ?? "OBJECTIVE",
      quote: finding?.quote ?? criterion,
      detail:
        finding?.detail ??
        (bounded
          ? "Independent review unavailable or invalid"
          : "Result diff exceeds bounded review packet"),
      question:
        finding?.question?.trim() ||
        `Does this exact result tree satisfy: ${criterion}?`,
    });
  }
  return { ...evidence, criteria: proven };
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

/** npm resolves scripts and lifecycle hooks from the result worktree. Pin that
 * implementation to the accepted Objective base before any shell runs. */
export function assertPinnedNpmScripts(
  checkout: string,
  acceptedBaseSha: string,
  commit: string,
  commands: string[],
): void {
  const npmCommands = commands.filter((check) => /\bnpm\b/.test(check));
  if (!npmCommands.length) return;
  if (
    npmCommands.some(
      (check) => !/^npm (?:test|run [A-Za-z0-9:_-]+)$/.test(check.trim()),
    )
  )
    throw new Error(
      "npm validation command blocked: only root npm test or npm run NAME can be pinned",
    );
  for (const path of ["package.json", ".npmrc"]) {
    const blob = (revision: string): string | undefined => {
      try {
        return pinnedGit(checkout, "rev-parse", `${revision}:${path}`);
      } catch {
        return undefined;
      }
    };
    const before = blob(acceptedBaseSha);
    const after = blob(commit);
    if ((path === "package.json" && !before) || before !== after)
      throw new Error(
        `npm validation command blocked: ${path} differs from the accepted base`,
      );
  }
}

export function validateWorkItem(
  checkout: string,
  root: string,
  item: WorkItem,
  commit: string,
  treeSha: string,
  acceptedBaseSha: string,
  observe?: (entry: ValidationObservation) => void,
): ValidationEvidence {
  assertPinnedNpmScripts(
    checkout,
    acceptedBaseSha,
    commit,
    item.validation.map((v) => v.command),
  );
  return validateTree(
    checkout,
    root,
    commit,
    treeSha,
    item.validation.map((v) => v.command),
    observe,
  );
}
