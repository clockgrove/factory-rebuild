import { Codex } from "@openai/codex-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { validateAndOrderGraph } from "./scheduler.js";
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
                path: { type: "string" },
                role: { type: "string" },
                mediaType: { type: "string" },
                visibility: { type: "string", enum: ["private", "repository"] },
              },
              required: ["path", "role", "mediaType", "visibility"],
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
    const prompt = `Compile this human Objective into the smallest complete dependency-aware Work Item graph. Use parallel lanes only when ownership and resources allow them. Return the requested JSON only. Use exact supplied base SHA and Objective number. Cite only supplied source paths. Give each item explicit non-goals. Choose observable acceptance and owned paths. For every validation command, set provenance to base-observed or source-declared. If source-declared, set source to the exact supplied path that declares it, such as OBJECTIVE or AGENTS.md; if base-observed, set source to an empty string. For each repository source asset, bind its path, role, media type, and private or repository visibility. Use an explicitly declared media type when available, otherwise application/octet-stream; never infer format from an extension. List expected output roles for media work; use empty arrays for ordinary work. Set minimumAssetSets from the Objective candidate count, or 1 for unspecified media and 0 for ordinary work. List requiredLfsRoles only when a supplied source requires them; the target repository .gitattributes is authoritative. Do not add deployment, paid services, providers, recovery, or later scope.\n\nObjective:\n${request.objective}\n\nBase: ${request.baseSha}\n\nSources:\n${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}`;
    const result = await thread.run(prompt, { outputSchema: request.schema });
    return JSON.parse(result.finalResponse) as T;
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
): void {
  const byPath = new Map(
    sources.map((source) => [source.path, source.content]),
  );
  for (const item of graph.items) {
    for (const check of item.validation) {
      if (
        check.provenance === "source-declared" &&
        !byPath.get(check.source ?? "")?.includes(check.command)
      ) {
        throw new Error(
          `Work Item ${item.id} cites an undeclared validation command in ${check.source ?? "unknown source"}`,
        );
      }
    }
  }
}

export async function compileObjective(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel = new CodexPlanningModel(checkout),
  extraSources: { path: string; content: string }[] = [],
): Promise<WorkGraph> {
  const sources = [{ path: "OBJECTIVE", content: body }];
  for (const path of ["AGENTS.md", "README.md"]) {
    const full = join(checkout, path);
    if (existsSync(full))
      sources.push({ path, content: readFileSync(full, "utf8") });
  }
  sources.push(...extraSources);
  const prompt = `Objective #${objective}\n${body}`;
  const graph = await model.generateStructured<WorkGraph>({
    objective: prompt,
    baseSha,
    sources,
    schema: graphSchema,
  });
  validateGraph(graph, objective, baseSha, new Set(sources.map((s) => s.path)));
  validateCommandProvenance(graph, sources);
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
      const binding =
        typeof source === "string"
          ? {
              path: source,
              role: "source",
              mediaType: "application/octet-stream",
              visibility: "repository",
            }
          : source;
      const { path, role, mediaType, visibility } = binding;
      if (
        !role ||
        !mediaType ||
        !["private", "repository"].includes(visibility) ||
        !/^[A-Za-z0-9_./-]+$/.test(path) ||
        path.startsWith("/") ||
        path.split("/").includes("..") ||
        !existsSync(join(checkout, path))
      )
        throw new Error(
          `Work Item ${item.id} cites an unavailable or invalid source asset: ${path}`,
        );
    }
  }
  return graph;
}
