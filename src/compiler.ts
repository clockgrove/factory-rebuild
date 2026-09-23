import { Codex } from "@openai/codex-sdk";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { recognizedObjectiveAttachment } from "./media.js";
import { validateAndOrderGraph } from "./scheduler.js";
import { pinnedGit, pinnedGitRaw } from "./process.js";
import {
  assertPinnedNpmScripts,
  packageScriptInvocation,
  PINNED_PNPM_BOOTSTRAP,
} from "./validation.js";
import type { PlanningModel, PlanningRequest, WorkGraph } from "./contracts.js";

export const graphSchema = {
  type: "object",
  properties: {
    objective: { type: "integer" },
    baseSha: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          goal: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
          nonGoals: { type: "array", items: { type: "string" } },
          citations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                heading: { type: "string" },
              },
              required: ["path", "heading"],
              additionalProperties: false,
            },
          },
          dependencies: { type: "array", items: { type: "string" } },
          ownedPaths: { type: "array", items: { type: "string" } },
          resources: { type: "array", items: { type: "string" } },
          validation: {
            type: "array",
            items: {
              type: "object",
              properties: {
                command: { type: "string" },
                provenance: {
                  type: "string",
                  enum: ["base-observed", "source-declared"],
                },
                source: { type: "string" },
              },
              required: ["command", "provenance", "source"],
              additionalProperties: false,
            },
          },
          brief: { type: "string" },
          sourceAssets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                kind: {
                  type: "string",
                  enum: ["repository", "local", "github-attachment"],
                },
                path: { type: "string" },
                role: { type: "string" },
                mediaType: { type: "string" },
                visibility: { type: "string", enum: ["private", "repository"] },
              },
              required: ["kind", "path", "role", "mediaType", "visibility"],
              additionalProperties: false,
            },
          },
          expectedOutputRoles: { type: "array", items: { type: "string" } },
          minimumAssetSets: { type: "integer" },
          requiredLfsRoles: { type: "array", items: { type: "string" } },
        },
        required: [
          "id",
          "title",
          "goal",
          "acceptance",
          "nonGoals",
          "citations",
          "dependencies",
          "ownedPaths",
          "resources",
          "validation",
          "brief",
          "sourceAssets",
          "expectedOutputRoles",
          "minimumAssetSets",
          "requiredLfsRoles",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["objective", "baseSha", "items"],
  additionalProperties: false,
};

export class CodexPlanningModel implements PlanningModel {
  constructor(private checkout: string) {}

  async generateStructured<T>(request: PlanningRequest<T>): Promise<T> {
    const codex = new Codex();
    const thread = codex.startThread({
      workingDirectory: this.checkout,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    });
    const prompt = `Compile this human Objective into the smallest complete dependency-aware Work Item graph. Use parallel lanes only when ownership and resources allow them. Return the requested JSON only. Use exact supplied base SHA and Objective number. Cite only supplied source paths. Give each item explicit non-goals. Choose observable acceptance and owned paths. For every validation command, set provenance to base-observed or source-declared and name its exact source path. A source-declared command must be an exact command line in a supplied source (OBJECTIVE or a pinned source). A base-observed command must identify a tracked file in the exact base containing that command as an exact line, or a package.json script invoked by npm test/npm run NAME/pnpm test/pnpm check/pnpm run NAME. The exact source-declared command pnpm install --frozen-lockfile --ignore-scripts may precede pnpm checks in a fresh validation worktree when supplied; plain install is unsupported. Do not invent commands or use a vague source. For each source asset, bind its path, role, media type, visibility, and kind: repository for a pinned checkout path, local for an explicitly approved absolute private file, or github-attachment for a recognized URL literally present in the Objective. Use an explicitly declared media type when available, otherwise application/octet-stream; never infer format from an extension. List expected output roles for media work; use empty arrays for ordinary work. Set minimumAssetSets from the Objective candidate count, or 1 for unspecified media and 0 for ordinary work. List requiredLfsRoles only when a supplied source requires them; the target repository .gitattributes is authoritative. Do not add deployment, paid services, providers, recovery, or later scope.\n\nObjective:\n${request.objective}\n\nBase: ${request.baseSha}\n\nSources:\n${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}`;
    const result = await thread.run(prompt, { outputSchema: request.schema });
    return JSON.parse(result.finalResponse) as T;
  }

  async reviewGraph(request: {
    objective: string;
    baseSha: string;
    sources: { path: string; content: string }[];
    graph: WorkGraph;
  }): Promise<{
    findings: {
      source: string;
      quote: string;
      detail: string;
      question: string;
    }[];
  }> {
    const codex = new Codex();
    const thread = codex.startThread({
      workingDirectory: this.checkout,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    });
    const prompt = `Independently review this proposed Factory Work Item graph against the exact pinned Objective and source packet. Check every Objective obligation, unsupported scope, citations, dependencies, path/resource ownership, and observable acceptance. Return only material findings with the supplied source path and a short exact quote from that source. Give a specific operator question for unresolved authority. Do not edit the graph or grant authority. A clean graph has an empty findings array.\n\nObjective:\n${request.objective}\nBase: ${request.baseSha}\nSources:\n${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}\nGraph:\n${JSON.stringify(request.graph)}`;
    const result = await thread.run(prompt, {
      outputSchema: {
        type: "object",
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source: { type: "string" },
                quote: { type: "string" },
                detail: { type: "string" },
                question: { type: "string" },
              },
              required: ["source", "quote", "detail", "question"],
              additionalProperties: false,
            },
          },
        },
        required: ["findings"],
        additionalProperties: false,
      },
    });
    return JSON.parse(result.finalResponse);
  }

  async reviewResult(request: {
    criteria: string[];
    baseSha: string;
    treeSha: string;
    sources: { path: string; content: string }[];
    change: string;
    commands: { command: string; passed: true }[];
    observations?: string;
  }): Promise<{
    findings: {
      criterion: string;
      verdict: "pass" | "needs-human" | "refuse";
      source: string;
      quote: string;
      detail: string;
      question: string;
    }[];
  }> {
    const codex = new Codex();
    const thread = codex.startThread({
      workingDirectory: this.checkout,
      sandboxMode: "read-only",
      approvalPolicy: "never",
    });
    const result = await thread.run(
      `Independently review the exact result of a Factory Objective. Decide each criterion only from the supplied pinned source, command pass evidence, delivery observations when supplied, and exact Git change packet. The packet has bounded text patch excerpts, explicit truncation flags, line counts, and exact blob identities/sizes. Never pass a criterion when relevant text is truncated or omitted unless other supplied evidence independently proves it. Blob identity alone does not prove opaque content semantics; ask for a focused human decision when missing evidence matters. A shell exit code alone proves only that command's assertion. Return one finding per criterion in the given order. Pass only when the evidence proves that criterion; otherwise needs-human with one specific question. Use refuse for a directly disproved criterion. Quote an exact source fragment for every finding. Never edit or run commands.\n\nBase: ${request.baseSha}\nResult tree: ${request.treeSha}\nCriteria: ${JSON.stringify(request.criteria)}\nCommands: ${JSON.stringify(request.commands)}\nDelivery observations: ${request.observations ?? "none"}\nSources: ${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}\nChange packet:\n${request.change}`,
      {
        outputSchema: {
          type: "object",
          properties: {
            findings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  criterion: { type: "string" },
                  verdict: {
                    type: "string",
                    enum: ["pass", "needs-human", "refuse"],
                  },
                  source: { type: "string" },
                  quote: { type: "string" },
                  detail: { type: "string" },
                  question: { type: "string" },
                },
                required: [
                  "criterion",
                  "verdict",
                  "source",
                  "quote",
                  "detail",
                  "question",
                ],
                additionalProperties: false,
              },
            },
          },
          required: ["findings"],
          additionalProperties: false,
        },
      },
    );
    return JSON.parse(result.finalResponse);
  }
}

export function validateGraph(
  graph: WorkGraph,
  objective: number,
  baseSha: string,
  sources: Set<string>,
): void {
  validateAndOrderGraph(graph, objective, baseSha, sources);
}

export function validateCommandProvenance(
  graph: WorkGraph,
  sources: { path: string; content: string }[],
  checkout: string,
): void {
  for (const item of graph.items) {
    for (const check of item.validation) {
      if (!authorizedCommand(check, graph.baseSha, sources, checkout)) {
        throw new Error(
          `Work Item ${item.id} has no exact ${check.provenance} command authority in ${check.source ?? "unknown source"}: ${check.command}`,
        );
      }
    }
  }
}

export interface PlanningSource {
  path: string;
  content: string;
  heading?: string;
}

export interface PlanCandidate {
  schemaVersion: 1;
  objective: number;
  baseSha: string;
  bodyDigest: string;
  sources: PlanningSource[];
  sourceDigests: { path: string; heading?: string; digest: string }[];
  graph: WorkGraph;
  graphDigest: string;
  commands: {
    itemId: string;
    command: string;
    provenance: "base-observed" | "source-declared";
    source?: string;
    hostExecution: "authorized" | "blocked";
    reason: string;
  }[];
  finalCommands: string[];
  humanDecision?: {
    question: string;
    answer: string;
    actor: string;
    at: string;
    outcome: "accept" | "refuse";
    reason: string;
  };
  review: {
    status: "clean" | "needs-human" | "refused";
    revisions: number;
    findings: {
      source: string;
      quote: string;
      detail: string;
      question: string;
    }[];
  };
}

function decisionSource(
  decision: NonNullable<PlanCandidate["humanDecision"]>,
): PlanningSource {
  return {
    path: "OPERATOR_DECISION",
    content: JSON.stringify(decision),
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function commandAuthorizations(
  graph: WorkGraph,
  sources: PlanningSource[],
  checkout: string,
): PlanCandidate["commands"] {
  const workCommands = graph.items.flatMap((item) =>
    item.validation.map((check) => {
      const declared = authorizedCommand(
        check,
        graph.baseSha,
        sources,
        checkout,
      );
      return {
        itemId: item.id,
        command: check.command,
        provenance: check.provenance,
        ...(check.source ? { source: check.source } : {}),
        hostExecution: declared
          ? ("authorized" as const)
          : ("blocked" as const),
        reason: declared
          ? "Exact command line in cited pinned source"
          : "No exact command declaration in cited pinned source or base",
      };
    }),
  );
  const objective = sources.find((source) => source.path === "OBJECTIVE");
  return [
    ...workCommands,
    ...finalObjectiveCommands(objective?.content ?? "").map((command) => {
      const authorized = authorizedCommand(
        { command, provenance: "source-declared", source: "OBJECTIVE" },
        graph.baseSha,
        sources,
        checkout,
      );
      return {
        itemId: "OBJECTIVE",
        command,
        provenance: "source-declared" as const,
        source: "OBJECTIVE",
        hostExecution: authorized
          ? ("authorized" as const)
          : ("blocked" as const),
        reason: authorized
          ? "Exact final command line in pinned Objective"
          : "Final command has no executable authority at the accepted base",
      };
    }),
  ];
}

/** Final commands are accepted only as exact lines under the Objective heading. */
export function finalObjectiveCommands(body: string): string[] {
  const section = objectiveSection(body, ["Final validation"]);
  return section.split("\n").flatMap((line) => {
    const match = line.match(/^\s*-\s+(`[^`]+`|[^`]+?)\s*$/);
    return match ? [match[1]!.replace(/^`|`$/g, "")] : [];
  });
}

export function objectiveCriteria(body: string): string[] {
  const acceptance = objectiveSection(body, [
    "Acceptance",
    "What must be true",
  ]);
  const section = acceptance || objectiveSection(body, ["Goal", "Outcome"]);
  return section.split(/\n\s*\n/).flatMap((paragraph) => {
    const criteria: string[] = [];
    for (const line of paragraph.split("\n")) {
      const text = line.trim();
      if (!text) continue;
      const list = text.match(/^(?:[-*]|\d+[.)])\s+(.+)$/);
      if (list) criteria.push(list[1]!);
      else if (criteria.length) criteria[criteria.length - 1] += ` ${text}`;
      else criteria.push(text);
    }
    return criteria;
  });
}

function objectiveSection(body: string, names: string[]): string {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => {
    const heading = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    return Boolean(
      heading &&
      names.some((name) => heading[2]!.toLowerCase() === name.toLowerCase()),
    );
  });
  if (start < 0) return "";
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex(
    (line, index) =>
      index > start && new RegExp(`^#{1,${level}}\\s+`).test(line),
  );
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

function exactLine(content: string, command: string): boolean {
  return content.split("\n").some((line) => {
    const text = line
      .trim()
      .replace(/^[-*]\s+/, "")
      .trim();
    return text === command || text === `\`${command}\``;
  });
}

function authorizedCommand(
  check: WorkGraph["items"][number]["validation"][number],
  baseSha: string,
  sources: PlanningSource[],
  checkout: string,
): boolean {
  if (!check.command.trim() || !check.source) return false;
  const packageCommand = /\b(?:npm|pnpm)\b/.test(check.command);
  const bootstrap = check.command.trim() === PINNED_PNPM_BOOTSTRAP;
  const invocation =
    packageCommand && !bootstrap
      ? packageScriptInvocation(check.command)
      : undefined;
  if (packageCommand) {
    if (bootstrap) {
      if (check.provenance !== "source-declared") return false;
      try {
        pinnedGit(checkout, "cat-file", "-e", `${baseSha}:pnpm-lock.yaml`);
      } catch {
        return false;
      }
    } else {
      if (!invocation) return false;
      try {
        const pkg = JSON.parse(
          pinnedGitRaw(checkout, "show", `${baseSha}:package.json`).toString(
            "utf8",
          ),
        );
        if (typeof pkg?.scripts?.[invocation.name] !== "string") return false;
      } catch {
        return false;
      }
    }
    try {
      assertPinnedNpmScripts(checkout, baseSha, baseSha, [check.command]);
    } catch {
      return false;
    }
  }
  if (
    check.provenance === "source-declared" &&
    check.source !== "OPERATOR_DECISION"
  )
    return sources.some(
      (source) =>
        source.path === check.source &&
        exactLine(source.content, check.command),
    );
  if (
    check.provenance !== "base-observed" ||
    !/^[A-Za-z0-9_./-]+$/.test(check.source) ||
    check.source.split("/").includes("..")
  )
    return false;
  let content: string;
  try {
    content = pinnedGitRaw(
      checkout,
      "show",
      `${baseSha}:${check.source}`,
    ).toString("utf8");
  } catch {
    return false;
  }
  if (exactLine(content, check.command)) return true;
  if (check.source !== "package.json") return false;
  return Boolean(invocation);
}

function planningFailure(error: unknown): never {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    /context (window|length)|token limit|too (many|long) tokens|input too long/i.test(
      detail,
    )
  )
    throw new Error(
      `Complete planning source packet exceeds the selected model context; narrow the named headings or choose a model with more context. If the Objective still cannot fit, split it explicitly. ${detail}`,
    );
  throw error;
}

function selectedHeadings(body: string): { path: string; heading?: string }[] {
  const section = body.match(
    /^## Planning sources\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/im,
  )?.[1];
  if (!section) return [];
  return section
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const value = line
        .match(/^\s*-\s+(?:`([^`]+)`|(\S+))\s*$/)
        ?.slice(1)
        .find(Boolean);
      if (!value)
        throw new Error(`Invalid Planning sources entry: ${line.trim()}`);
      const split = value.indexOf("#");
      return split < 0
        ? { path: value }
        : { path: value.slice(0, split), heading: value.slice(split + 1) };
    });
}

function pinnedText(checkout: string, baseSha: string, path: string): string {
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`Invalid planning source path: ${path}`);
  let bytes: Buffer;
  try {
    bytes = pinnedGitRaw(checkout, "show", `${baseSha}:${path}`);
  } catch {
    throw new Error(`Planning source ${path} is missing at base ${baseSha}`);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      `Planning source ${path} is not UTF-8 text at base ${baseSha}`,
    );
  }
}

function sectionText(path: string, text: string, heading: string): string {
  const lines = text.split("\n");
  const matches = lines.flatMap((line, index) => {
    const match = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    return match && match[2] === heading
      ? [{ index, level: match[1]!.length }]
      : [];
  });
  if (matches.length !== 1)
    throw new Error(
      `Planning source ${path} has ${matches.length} headings named ${heading}; select one exact heading`,
    );
  const { index, level } = matches[0]!;
  const end = lines.findIndex(
    (line, at) => at > index && new RegExp(`^#{1,${level}}\\s+`).test(line),
  );
  return lines.slice(index, end < 0 ? undefined : end).join("\n");
}

/** The exact source packet consumed by both read-only preview and run. */
export function planningSources(
  body: string,
  baseSha: string,
  checkout: string,
): PlanningSource[] {
  const sources: PlanningSource[] = [{ path: "OBJECTIVE", content: body }];
  const selected = selectedHeadings(body);
  const defaults = ["AGENTS.md", "README.md"].filter((path) => {
    try {
      pinnedGit(checkout, "cat-file", "-e", `${baseSha}:${path}`);
      return true;
    } catch {
      return false;
    }
  });
  const identities = new Set<string>();
  for (const { path, heading } of [
    ...defaults.map((path) => ({ path, heading: undefined })),
    ...selected,
  ]) {
    const identity = `${path}#${heading ?? ""}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    const text = pinnedText(checkout, baseSha, path);
    sources.push({
      path,
      ...(heading ? { heading } : {}),
      content: heading ? sectionText(path, text, heading) : text,
    });
  }
  return sources;
}

function validateCitations(graph: WorkGraph, sources: PlanningSource[]): void {
  for (const item of graph.items) {
    for (const citation of item.citations) {
      const matching = sources.filter(
        (source) => source.path === citation.path,
      );
      if (!matching.length)
        throw new Error(
          `Work Item ${item.id} cites unavailable source ${citation.path}`,
        );
      if (
        citation.heading &&
        !matching.some((source) =>
          source.content.split("\n").some((line) => {
            const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
            return heading === citation.heading;
          }),
        )
      )
        throw new Error(
          `Work Item ${item.id} cites missing heading ${citation.heading} in ${citation.path}`,
        );
    }
  }
}

export async function compileObjective(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel,
  extraSources: { path: string; content: string }[] = [],
  reviewFindings: { source: string; quote: string; detail: string }[] = [],
): Promise<WorkGraph> {
  const sources = planningSources(body, baseSha, checkout);
  sources.push(...extraSources);
  const prompt = `Objective #${objective}\n${body}${reviewFindings.length ? `\n\nOne independent review found these sourced defects. Revise the complete graph once; do not expand scope or invent authority:\n${JSON.stringify(reviewFindings)}` : ""}`;
  const graph = await model
    .generateStructured<WorkGraph>({
      objective: prompt,
      baseSha,
      sources,
      schema: graphSchema,
    })
    .catch(planningFailure);
  validateGraph(graph, objective, baseSha, new Set(sources.map((s) => s.path)));
  validateCitations(graph, sources);
  for (const item of graph.items) {
    if (
      new Set(item.expectedOutputRoles ?? []).size !==
      (item.expectedOutputRoles ?? []).length
    )
      throw new Error(
        `Work Item ${item.id} has duplicate expected output roles`,
      );
    if (
      !Number.isSafeInteger(item.minimumAssetSets) ||
      (item.minimumAssetSets ?? 0) < 0 ||
      ((item.expectedOutputRoles?.length ?? 0) > 0 &&
        (item.minimumAssetSets ?? 0) < 1)
    )
      throw new Error(`Work Item ${item.id} has an invalid candidate count`);
    if (
      (item.requiredLfsRoles ?? []).some(
        (role) => !item.expectedOutputRoles?.includes(role),
      )
    )
      throw new Error(
        `Work Item ${item.id} requires LFS for an unknown output role`,
      );
    for (const source of item.sourceAssets ?? []) {
      if (typeof source === "string")
        throw new Error(`Work Item ${item.id} needs a structured source asset`);
      const { path, role, mediaType, visibility } = source;
      const kind = source.kind ?? "repository";
      const repositoryPath =
        /^[A-Za-z0-9_./-]+$/.test(path) &&
        !path.startsWith("/") &&
        !path.split("/").includes("..");
      const available =
        kind === "repository"
          ? (() => {
              if (!repositoryPath) return false;
              try {
                pinnedGit(checkout, "cat-file", "-e", `${baseSha}:${path}`);
                return true;
              } catch {
                return false;
              }
            })()
          : kind === "local"
            ? visibility === "private" &&
              isAbsolute(path) &&
              body.includes(path)
            : kind === "github-attachment"
              ? recognizedObjectiveAttachment(path) && body.includes(path)
              : false;
      if (
        !role ||
        !mediaType ||
        !["private", "repository"].includes(visibility) ||
        !available
      )
        throw new Error(
          `Work Item ${item.id} cites an unavailable or invalid source asset: ${path}`,
        );
    }
  }
  return graph;
}

function checkedFindings(
  findings: {
    source: string;
    quote: string;
    detail: string;
    question: string;
  }[],
  sources: PlanningSource[],
): { source: string; quote: string; detail: string; question: string }[] {
  if (!Array.isArray(findings))
    throw new Error("Graph review has no findings array");
  for (const finding of findings) {
    if (
      !finding ||
      !finding.quote?.trim() ||
      !sources.some(
        (source) =>
          source.path === finding.source &&
          source.content.includes(finding.quote),
      ) ||
      !finding.detail?.trim() ||
      !finding.question?.trim()
    )
      throw new Error(
        "Graph review finding lacks a supplied source or question",
      );
  }
  return findings;
}

/** Compile and independently review a candidate without GitHub or run-state writes. */
export async function compilePlan(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel,
): Promise<PlanCandidate> {
  const sources = planningSources(body, baseSha, checkout);
  let graph = await compileObjective(objective, body, baseSha, checkout, model);
  let findings = checkedFindings(
    (
      await model
        .reviewGraph({ objective: body, baseSha, sources, graph })
        .catch(planningFailure)
    ).findings,
    sources,
  );
  let revisions = 0;
  if (findings.length) {
    try {
      graph = await compileObjective(
        objective,
        body,
        baseSha,
        checkout,
        model,
        [],
        findings,
      );
      revisions = 1;
      findings = checkedFindings(
        (
          await model
            .reviewGraph({ objective: body, baseSha, sources, graph })
            .catch(planningFailure)
        ).findings,
        sources,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Complete planning source packet exceeds")
      )
        throw error;
      findings = [
        {
          source: findings[0]!.source,
          quote: findings[0]!.quote,
          detail: `Graph revision failed: ${error instanceof Error ? error.message : String(error)}`,
          question: findings[0]!.question,
        },
      ];
    }
  }
  return {
    schemaVersion: 1,
    objective,
    baseSha,
    bodyDigest: digest(body),
    sources,
    sourceDigests: sources.map(({ path, heading, content }) => ({
      path,
      ...(heading ? { heading } : {}),
      digest: digest(content),
    })),
    graph,
    graphDigest: digest(JSON.stringify(graph)),
    commands: commandAuthorizations(graph, sources, checkout),
    finalCommands: finalObjectiveCommands(body),
    review: {
      status: findings.length ? "needs-human" : "clean",
      revisions,
      findings,
    },
  };
}

/** Reject a stale or modified preview before activating its exact graph. */
export function verifyPlanCandidate(
  candidate: PlanCandidate,
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  allowPending = false,
): void {
  const expectedSources = planningSources(body, baseSha, checkout);
  if (candidate.humanDecision)
    expectedSources.push(decisionSource(candidate.humanDecision));
  if (
    candidate.schemaVersion !== 1 ||
    candidate.objective !== objective ||
    candidate.baseSha !== baseSha ||
    candidate.bodyDigest !== digest(body) ||
    JSON.stringify(candidate.sources) !== JSON.stringify(expectedSources) ||
    candidate.graphDigest !== digest(JSON.stringify(candidate.graph)) ||
    JSON.stringify(candidate.commands) !==
      JSON.stringify(
        commandAuthorizations(candidate.graph, expectedSources, checkout),
      ) ||
    JSON.stringify(candidate.finalCommands) !==
      JSON.stringify(finalObjectiveCommands(body)) ||
    JSON.stringify(candidate.sourceDigests) !==
      JSON.stringify(
        expectedSources.map(({ path, heading, content }) => ({
          path,
          ...(heading ? { heading } : {}),
          digest: digest(content),
        })),
      )
  )
    throw new Error(
      "Plan candidate differs from the current Objective, base, or source packet; run plan again",
    );
  if (
    !allowPending &&
    (candidate.review.status !== "clean" || candidate.review.findings.length)
  )
    throw new Error("Plan needs a specific human source decision before run");
  if (
    !allowPending &&
    candidate.commands.some((command) => command.hostExecution !== "authorized")
  )
    throw new Error(
      "Plan contains a command without established host execution authority",
    );
  validateGraph(
    candidate.graph,
    objective,
    baseSha,
    new Set(candidate.sourceDigests.map((source) => source.path)),
  );
  validateCitations(candidate.graph, candidate.sources);
  validateCommandProvenance(candidate.graph, candidate.sources, checkout);
}

/** Record a specific human fallback and re-review the resulting graph. */
export async function resolvePlan(
  candidate: PlanCandidate,
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel,
  input: {
    actor: string;
    outcome: "accept" | "refuse";
    answer: string;
    reason: string;
  },
): Promise<PlanCandidate> {
  verifyPlanCandidate(candidate, objective, body, baseSha, checkout, true);
  if (
    candidate.review.status !== "needs-human" ||
    !candidate.review.findings.length
  )
    throw new Error("This plan has no unresolved specific human question");
  if (
    !input.actor.trim() ||
    !input.reason.trim() ||
    (input.outcome === "accept" && !input.answer.trim())
  )
    throw new Error(
      "A human decision needs actor, reason, and a specific answer when accepted",
    );
  const decision = {
    question: candidate.review.findings[0]!.question,
    answer: input.answer,
    actor: input.actor,
    at: new Date().toISOString(),
    outcome: input.outcome,
    reason: input.reason,
  };
  const sources = [
    ...planningSources(body, baseSha, checkout),
    decisionSource(decision),
  ];
  if (input.outcome === "refuse")
    return {
      ...candidate,
      humanDecision: decision,
      sources,
      sourceDigests: sources.map(({ path, heading, content }) => ({
        path,
        ...(heading ? { heading } : {}),
        digest: digest(content),
      })),
      review: { ...candidate.review, status: "refused" },
    };
  const graph = await compileObjective(
    objective,
    body,
    baseSha,
    checkout,
    model,
    [decisionSource(decision)],
    candidate.review.findings,
  );
  const findings = checkedFindings(
    (
      await model
        .reviewGraph({ objective: body, baseSha, sources, graph })
        .catch(planningFailure)
    ).findings,
    sources,
  );
  return {
    ...candidate,
    humanDecision: decision,
    sources,
    sourceDigests: sources.map(({ path, heading, content }) => ({
      path,
      ...(heading ? { heading } : {}),
      digest: digest(content),
    })),
    graph,
    graphDigest: digest(JSON.stringify(graph)),
    commands: commandAuthorizations(graph, sources, checkout),
    finalCommands: finalObjectiveCommands(body),
    review: {
      status: findings.length ? "needs-human" : "clean",
      revisions: candidate.review.revisions,
      findings,
    },
  };
}
