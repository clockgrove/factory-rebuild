import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PlanningModel, WorkItem } from "./contracts.js";
import { command, pinnedGit, sanitizedWorkerEnvironment } from "./process.js";

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

export function validateTree(
  checkout: string,
  root: string,
  commit: string,
  expectedTree: string,
  commands: string[],
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
    for (const check of commands) {
      command(
        "sh",
        ["-lc", check],
        worktree,
        sanitizedWorkerEnvironment(emptyCredentials),
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
): ValidationEvidence {
  return validateTree(
    checkout,
    root,
    commit,
    treeSha,
    item.validation.map((v) => v.command),
  );
}
