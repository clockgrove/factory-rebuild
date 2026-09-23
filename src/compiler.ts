import { Codex } from "@openai/codex-sdk";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  PlanningModel,
  PlanningRequest,
  WorkGraph,
  WorkItem,
} from "./contracts.js";

const schema = {
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
          "citations",
          "dependencies",
          "ownedPaths",
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
    const prompt = `Compile this human Objective into exactly one minimal Work Item for the walking skeleton. Return the requested JSON only. Use exact supplied base SHA and Objective number. Cite only supplied source paths. Choose observable acceptance and owned paths. For every validation command, set provenance to base-observed or source-declared. If source-declared, set source to the exact supplied path that declares it, such as OBJECTIVE or AGENTS.md; if base-observed, set source to an empty string. Do not add deployment, providers, recovery, or later scope.\n\nObjective:\n${request.objective}\n\nBase: ${request.baseSha}\n\nSources:\n${request.sources.map((s) => `--- ${s.path} ---\n${s.content}`).join("\n")}`;
    const result = await thread.run(prompt, { outputSchema: request.schema });
    return JSON.parse(result.finalResponse) as T;
  }
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.split("/").includes("..") &&
    !path.includes("\\")
  );
}

export function validateGraph(
  graph: WorkGraph,
  objective: number,
  baseSha: string,
  sources: Set<string>,
): void {
  if (
    graph.objective !== objective ||
    graph.baseSha !== baseSha ||
    graph.items.length !== 1
  ) {
    throw new Error(
      "Walking skeleton requires one Work Item at the exact Objective base",
    );
  }
  const item: WorkItem = graph.items[0]!;
  if (
    !item.id ||
    !item.title ||
    !item.goal ||
    !item.brief ||
    !item.acceptance.length ||
    !item.ownedPaths.length ||
    item.dependencies.length
  ) {
    throw new Error(
      "Compiled Work Item is missing required fields or has dependencies",
    );
  }
  if (
    !item.ownedPaths.every(safePath) ||
    !item.citations.length ||
    !item.citations.every((c) => sources.has(c.path))
  ) {
    throw new Error(
      "Compiled Work Item has unsafe paths or unsupported citations",
    );
  }
  for (const check of item.validation) {
    if (
      !check.command ||
      !["base-observed", "source-declared"].includes(check.provenance)
    ) {
      throw new Error("Validation command lacks provenance");
    }
    if (
      check.provenance === "source-declared" &&
      !sources.has(check.source ?? "")
    ) {
      throw new Error(
        `Source-declared command ${JSON.stringify(check.command)} cites ${JSON.stringify(check.source)}; expected one of ${[...sources].join(", ")}`,
      );
    }
  }
}

export async function compileObjective(
  objective: number,
  body: string,
  baseSha: string,
  checkout: string,
  model: PlanningModel = new CodexPlanningModel(checkout),
): Promise<WorkGraph> {
  const sources = [{ path: "OBJECTIVE", content: body }];
  for (const path of ["AGENTS.md", "README.md"]) {
    const full = join(checkout, path);
    if (existsSync(full))
      sources.push({ path, content: readFileSync(full, "utf8") });
  }
  const prompt = `Objective #${objective}\n${body}`;
  const graph = await model.generateStructured<WorkGraph>({
    objective: prompt,
    baseSha,
    sources,
    schema,
  });
  validateGraph(graph, objective, baseSha, new Set(sources.map((s) => s.path)));
  return graph;
}
