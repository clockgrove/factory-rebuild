import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { CapturedAssetSet, PlanningModel, WorkItem } from "./contracts.js";
import type { FactoryState } from "./state.js";
import {
  pinnedGit,
  pinnedGitRaw,
  pinnedGitEnvironment,
  sanitizedWorkerEnvironment,
} from "./process.js";

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

/**
 * Give result review the minimum authoritative run facts needed to evaluate
 * source-declared scheduling and predecessor criteria. The atomic snapshot and
 * accepted graph are lifecycle authority; diagnostics and worker prose are not.
 */
export function workItemReviewObservations(
  state: FactoryState,
  item: WorkItem,
  selectedAsset?: CapturedAssetSet,
): string {
  const criterionText = item.acceptance.join("\n");
  const namedByCriterion = (id: string): boolean => {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(
      `(?:^|[^A-Za-z0-9_-])${escaped}(?:$|[^A-Za-z0-9_-])`,
    ).test(criterionText);
  };
  const relevant = state.graph.items.filter((candidate) => {
    return (
      candidate.id === item.id ||
      item.dependencies.includes(candidate.id) ||
      namedByCriterion(candidate.id)
    );
  });
  return JSON.stringify({
    objectiveBaseSha: state.baseSha,
    currentIntegratedSha: state.integratedSha ?? null,
    reviewedItemId: item.id,
    attempts: relevant.map((candidate) => {
      const work = state.work[candidate.id]!;
      return {
        id: candidate.id,
        declaredDependencies: candidate.dependencies,
        attemptId: work.attempt ?? null,
        startedAt: work.startedAt ?? null,
        executionBaseSha: work.baseSha ?? null,
        integratedSha: work.integratedSha ?? null,
      };
    }),
    selectedAsset: selectedAsset ?? null,
  });
}

function resultChangePacket(
  checkout: string,
  baseSha: string,
  commit: string,
): { change: string; truncatedPaths: string[] } {
  const raw = pinnedGitRaw(
    checkout,
    "diff",
    "--raw",
    "--no-renames",
    "--abbrev=40",
    "-z",
    baseSha,
    commit,
    "--",
  )
    .toString("utf8")
    .split("\0");
  const changes: {
    path: string;
    status: string;
    oldMode: string;
    newMode: string;
    oldObject: string;
    newObject: string;
    oldBytes?: number;
    newBytes?: number;
  }[] = [];
  for (let index = 0; index + 1 < raw.length && raw[index]; index += 2) {
    const header = raw[index]!.match(
      /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])$/,
    );
    if (!header)
      throw new Error(
        "Cannot describe exact result change for independent review",
      );
    const size = (oid: string): number | undefined =>
      /^0{40}$/.test(oid)
        ? undefined
        : Number(pinnedGit(checkout, "cat-file", "-s", oid));
    const oldBytes = size(header[3]!);
    const newBytes = size(header[4]!);
    changes.push({
      path: raw[index + 1]!,
      status: header[5]!,
      oldMode: header[1]!,
      newMode: header[2]!,
      oldObject: header[3]!,
      newObject: header[4]!,
      ...(oldBytes === undefined ? {} : { oldBytes }),
      ...(newBytes === undefined ? {} : { newBytes }),
    });
  }
  // Leave room in the reviewer context for sources, criteria, and observations.
  // The operator can raise this limit for a model with a larger context window.
  const configured = Number(
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES ?? 48_000,
  );
  const textBudget =
    Number.isSafeInteger(configured) && configured > 0 ? configured : 48_000;
  let remaining = textBudget;
  const patches = changes.map(({ path }, index) => {
    const lineStats = pinnedGit(
      checkout,
      "diff",
      "--numstat",
      "--no-renames",
      baseSha,
      commit,
      "--",
      path,
    );
    if (remaining === 0)
      return { path, lineStats, excerpt: "", truncated: true };
    const limit = Math.ceil(remaining / (changes.length - index));
    const result = spawnSync(
      "git",
      [
        "-C",
        checkout,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        "--unified=2",
        baseSha,
        commit,
        "--",
        path,
      ],
      { env: pinnedGitEnvironment(), maxBuffer: limit },
    );
    if (
      result.error &&
      (result.error as NodeJS.ErrnoException).code !== "ENOBUFS"
    )
      throw result.error;
    if (!result.error && result.status !== 0)
      throw new Error(`Cannot describe text change for ${path}`);
    const output = result.stdout ?? Buffer.alloc(0);
    const excerpt = output.subarray(0, limit).toString("utf8");
    const truncated = Boolean(result.error) || output.length > limit;
    remaining -= Buffer.byteLength(excerpt, "utf8");
    return { path, lineStats, excerpt, truncated };
  });
  return {
    change: JSON.stringify({ changes, textBudget, patches }),
    truncatedPaths: patches
      .filter((patch) => patch.truncated)
      .map((patch) => patch.path),
  };
}

/** A separate read-only review evaluates each criterion on an exact-tree packet. */
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
  const { change, truncatedPaths } = resultChangePacket(
    checkout,
    baseSha,
    commit,
  );
  let findings: Awaited<
    ReturnType<NonNullable<PlanningModel["reviewResult"]>>
  >["findings"] = [];
  let reviewFailure: string | undefined;
  if (model.reviewResult) {
    try {
      const reviewed = await model.reviewResult({
        criteria,
        baseSha,
        treeSha: evidence.treeSha,
        sources,
        change,
        commands: evidence.commands,
        ...(args.observations ? { observations: args.observations } : {}),
      });
      if (!Array.isArray(reviewed.findings))
        throw new Error("review response has no findings array");
      findings = reviewed.findings;
    } catch (error) {
      reviewFailure = error instanceof Error ? error.message : String(error);
    }
  } else reviewFailure = "No independent result reviewer is configured";
  const evidenceSources = [
    { path: "Exact Git change packet", content: change },
    {
      path: "Command pass evidence",
      content: JSON.stringify(evidence.commands),
    },
    {
      path: "Delivery observations",
      content: args.observations ?? "",
    },
  ];
  const groundedSources = [...sources, ...evidenceSources];
  const patchExcerpts = (
    JSON.parse(change) as { patches: { excerpt: string }[] }
  ).patches.map((patch) => patch.excerpt);
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
    const candidate = findings[index];
    const finding =
      candidate?.criterion === criterion &&
      ["pass", "needs-human", "refuse"].includes(candidate.verdict) &&
      Boolean(candidate.detail?.trim()) &&
      groundedSources.some(
        (source) =>
          source.path === candidate.source &&
          Boolean(candidate.quote?.trim()) &&
          (source.content.includes(candidate.quote) ||
            (source.path === "Exact Git change packet" &&
              patchExcerpts.some((excerpt) =>
                excerpt.includes(candidate.quote),
              ))),
      )
        ? candidate
        : undefined;
    if (finding?.verdict === "pass" && truncatedPaths.length === 0) {
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
        finding?.verdict === "pass" && truncatedPaths.length > 0
          ? `Independent review cannot auto-pass because text excerpts were truncated for ${truncatedPaths.slice(0, 3).join(", ")}${truncatedPaths.length > 3 ? ` and ${truncatedPaths.length - 3} more path(s)` : ""}; a source quote and partial patch do not prove the full result.`
          : (finding?.detail ??
            (reviewFailure
              ? `Independent result review failed: ${reviewFailure}`
              : candidate
                ? "Independent result review returned invalid evidence for this criterion"
                : "Independent result review omitted this criterion")),
      question:
        finding?.verdict === "pass" && truncatedPaths.length > 0
          ? `Inspect tree ${evidence.treeSha} and decide this criterion, or retry with a larger FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES and reviewer context: ${criterion}`
          : finding?.question?.trim() ||
            `Inspect tree ${evidence.treeSha} and decide whether it satisfies this criterion, or retry with a reviewer able to read the change packet: ${criterion}`,
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

export interface ValidationOutputObservation {
  index: number;
  stream: "stdout" | "stderr";
  output: string;
  final: boolean;
}

export async function validateTree(
  checkout: string,
  root: string,
  commit: string,
  expectedTree: string,
  commands: string[],
  observe?: (entry: ValidationObservation) => void,
  observeOutput?: (entry: ValidationOutputObservation) => void,
): Promise<ValidationEvidence> {
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
      const child = spawn("sh", ["-lc", check], {
        cwd: worktree,
        env: sanitizedWorkerEnvironment(emptyCredentials),
      });
      let stdout = "";
      let stderr = "";
      const watch = (stream: "stdout" | "stderr") => {
        const decoder = new StringDecoder("utf8");
        child[stream].on("data", (chunk: Buffer) => {
          const text = decoder.write(chunk);
          if (stream === "stdout") stdout += text;
          else stderr += text;
          if (text)
            observeOutput?.({ index, stream, output: text, final: false });
        });
        return () => {
          const trailing = decoder.end();
          if (stream === "stdout") stdout += trailing;
          else stderr += trailing;
          observeOutput?.({ index, stream, output: trailing, final: true });
        };
      };
      const flushStdout = watch("stdout");
      const flushStderr = watch("stderr");
      const result = await new Promise<{
        status: number | null;
        error?: Error;
      }>((resolve) => {
        let error: Error | undefined;
        child.on("error", (cause: Error) => {
          error = cause;
        });
        child.on("close", (status: number | null) =>
          resolve({ status, error }),
        );
      });
      flushStdout();
      flushStderr();
      const output = `${stdout}${stderr}`;
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

/** Package managers resolve scripts and lifecycle hooks from the result tree.
 * Pin the selected entrypoint and execution config to the accepted base. */
export const PINNED_PNPM_BOOTSTRAP =
  "pnpm install --frozen-lockfile --ignore-scripts";

export interface PackageScriptAuthority {
  /** Commands literally declared by a pinned source, not inferred by the model. */
  sourceDeclared?: readonly string[];
  /** A plan may authorize creation of an entrypoint it cannot inspect yet. */
  preview?: boolean;
  /** Pin newly established scripts against the exact Work Item predecessor. */
  predecessorSha?: string;
}

export function assertPinnedNpmScripts(
  checkout: string,
  acceptedBaseSha: string,
  commit: string,
  commands: string[],
  authority: PackageScriptAuthority = {},
): void {
  const managerToken = /\b(?:npm|pnpm)\b/;
  const selected = commands.filter((check) => managerToken.test(check));
  if (!selected.length) return;
  const declared = new Set(authority.sourceDeclared ?? []);
  const bootstrap = selected.some(
    (check) => check.trim() === PINNED_PNPM_BOOTSTRAP,
  );
  if (
    bootstrap &&
    commands.findIndex((check) => check.trim() === PINNED_PNPM_BOOTSTRAP) >
      commands.findIndex((check) => managerToken.test(check))
  )
    throw new Error(
      "Package script validation blocked: script-disabled bootstrap must run first",
    );
  const scriptCommands = selected.filter(
    (check) => check.trim() !== PINNED_PNPM_BOOTSTRAP,
  );
  const requests = scriptCommands.map(packageScriptInvocation);
  if (requests.some((request) => !request))
    throw new Error(
      "Package script validation blocked: only root npm/pnpm test, pnpm check, or npm/pnpm run NAME can be pinned",
    );

  const file = (revision: string, path: string): string | undefined => {
    try {
      const entry = pinnedGit(checkout, "ls-tree", revision, "--", path);
      if (!entry) return undefined;
      if (!/^100(?:644|755) blob /.test(entry))
        throw new Error(
          `Package script validation blocked: ${path} is not a regular file`,
        );
      return pinnedGitRaw(checkout, "show", `${revision}:${path}`).toString(
        "utf8",
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("not a regular file")
      )
        throw error;
      return undefined;
    }
  };
  const packageFile = (
    revision: string,
  ): Record<string, unknown> | undefined => {
    const raw = file(revision, "package.json");
    if (raw === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("invalid package");
      return parsed as Record<string, unknown>;
    } catch {
      throw new Error(
        "Package script validation blocked: package.json is invalid",
      );
    }
  };
  const original = packageFile(acceptedBaseSha);
  const predecessor = packageFile(authority.predecessorSha ?? acceptedBaseSha);
  const after = packageFile(commit);
  if (!original && selected.some((command) => !declared.has(command)))
    throw new Error(
      "Package script validation blocked: a new package.json needs exact source-declared command authority",
    );
  if (!after && !authority.preview)
    throw new Error(
      "Package script validation blocked: package.json is absent from the result tree",
    );
  for (const key of ["packageManager", "config", "pnpm"])
    if (
      (original ?? predecessor) &&
      !isDeepStrictEqual((original ?? predecessor)?.[key], after?.[key])
    )
      throw new Error(
        `Package script validation blocked: ${key} differs from the accepted base`,
      );
  const scripts = (pkg: Record<string, unknown>): Record<string, unknown> => {
    const value = pkg.scripts;
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(
        "Package script validation blocked: scripts are unavailable",
      );
    return value as Record<string, unknown>;
  };
  const originalScripts =
    requests.length && original?.scripts ? scripts(original) : {};
  const predecessorScripts =
    requests.length && predecessor?.scripts ? scripts(predecessor) : {};
  const afterScripts = requests.length && after?.scripts ? scripts(after) : {};
  const usesPnpm =
    bootstrap || requests.some((request) => request!.manager === "pnpm");
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]!;
    const command = scriptCommands[index]!;
    const name = request.name;
    const beforeScripts =
      typeof originalScripts[name] === "string"
        ? originalScripts
        : predecessorScripts;
    const body = beforeScripts[name];
    if (typeof body !== "string" && !declared.has(command))
      throw new Error(
        `Package script validation blocked: new script ${name} needs exact source-declared command authority`,
      );
    if (
      (typeof body === "string" && afterScripts[name] !== body) ||
      (!authority.preview && typeof afterScripts[name] !== "string")
    )
      throw new Error(
        `Package script validation blocked: script ${name} differs from the accepted base`,
      );
    for (const scriptName of [name, `pre${name}`, `post${name}`]) {
      if (
        scriptName !== name &&
        typeof body !== "string" &&
        afterScripts[scriptName] !== undefined
      )
        throw new Error(
          `Package script validation blocked: new script ${name} cannot add lifecycle hook ${scriptName}`,
        );
      if (
        scriptName !== name &&
        beforeScripts[scriptName] !== afterScripts[scriptName]
      )
        throw new Error(
          `Package script validation blocked: lifecycle hook ${scriptName} differs from the accepted base`,
        );
      const scriptBody = afterScripts[scriptName] ?? beforeScripts[scriptName];
      if (typeof scriptBody !== "string") continue;
      if (/\b(?:npm|pnpm)\b/.test(scriptBody))
        throw new Error(
          `Package script validation blocked: nested package-manager invocation in ${scriptName} needs separate authority`,
        );
    }
  }
  if (
    usesPnpm &&
    (file(acceptedBaseSha, "package.yaml") !== undefined ||
      file(commit, "package.yaml") !== undefined)
  )
    throw new Error(
      "Package script validation blocked: pnpm package.yaml manifests are not supported",
    );
  if (bootstrap) {
    if (
      (!file(acceptedBaseSha, "pnpm-lock.yaml") &&
        !declared.has(PINNED_PNPM_BOOTSTRAP)) ||
      (!file(commit, "pnpm-lock.yaml") && !authority.preview)
    )
      throw new Error(
        "Package script validation blocked: frozen pnpm bootstrap needs a tracked lockfile",
      );
    for (const path of [".pnpmfile.cjs", ".pnpmfile.js", ".pnpmfile.mjs"])
      if (
        file(acceptedBaseSha, path) !== undefined ||
        file(commit, path) !== undefined
      )
        throw new Error(
          "Package script validation blocked: pnpmfile hooks need separate authority",
        );
  }
  for (const path of [".npmrc", ...(usesPnpm ? ["pnpm-workspace.yaml"] : [])]) {
    const original = file(acceptedBaseSha, path);
    const predecessor = file(authority.predecessorSha ?? acceptedBaseSha, path);
    if (
      (original ?? predecessor) !== file(commit, path) &&
      !(
        path === "pnpm-workspace.yaml" &&
        original === undefined &&
        predecessor === undefined &&
        selected.every((command) => declared.has(command))
      )
    )
      throw new Error(
        `Package script validation blocked: ${path} differs from the accepted base`,
      );
  }
  if (
    bootstrap &&
    [file(commit, ".npmrc"), file(commit, "pnpm-workspace.yaml")].some(
      (content) => /pnpmfile/i.test(content ?? ""),
    )
  )
    throw new Error(
      "Package script validation blocked: configured pnpmfile hooks need separate authority",
    );
}

/** Supported root script forms; shell wrappers and package-manager flags are ambiguous. */
export function packageScriptInvocation(
  check: string,
): { manager: "npm" | "pnpm"; name: string } | undefined {
  const match = check
    .trim()
    .match(/^(npm|pnpm) (?:(run) )?([A-Za-z0-9][A-Za-z0-9:_-]*)$/);
  if (!match) return undefined;
  const manager = match[1] as "npm" | "pnpm";
  const name = match[3]!;
  if (manager === "npm" && !match[2] && name !== "test") return undefined;
  if (manager === "pnpm" && !match[2] && !["check", "test"].includes(name))
    return undefined;
  return { manager, name };
}

export async function validateWorkItem(
  checkout: string,
  root: string,
  item: WorkItem,
  commit: string,
  treeSha: string,
  acceptedBaseSha: string,
  observe?: (entry: ValidationObservation) => void,
  observeOutput?: (entry: ValidationOutputObservation) => void,
  predecessorSha?: string,
): Promise<ValidationEvidence> {
  assertPinnedNpmScripts(
    checkout,
    acceptedBaseSha,
    commit,
    item.validation.map((v) => v.command),
    {
      sourceDeclared: item.validation
        .filter((v) => v.provenance === "source-declared")
        .map((v) => v.command),
      predecessorSha,
    },
  );
  return validateTree(
    checkout,
    root,
    commit,
    treeSha,
    item.validation.map((v) => v.command),
    observe,
    observeOutput,
  );
}
