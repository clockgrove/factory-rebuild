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
    const prompt = `Compile this human Objective into the smallest complete dependency-aware Work Item graph. Use parallel lanes only when ownership and resources allow them. Return the requested JSON only. Use exact supplied base SHA and Objective number. Cite only supplied source paths. Give each item explicit non-goals. Choose observable acceptance and owned paths. For every validation command, set provenance to base-observed or source-declared. If source-declared, set source to the exact supplied path that declares it, such as OBJECTIVE or AGENTS.md; if base-observed, set source to an empty string. Do not add deployment, paid services, providers, recovery, or later scope.\n\nObjective:\n${request.objective}\n\nBase: ${request.baseSha}\n\nSources:\n${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}`;
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
  return graph;
}
