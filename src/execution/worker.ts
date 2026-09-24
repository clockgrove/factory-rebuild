import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HarnessRequest } from "../contracts.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import { parseProducedAssetSets } from "../media.js";
import type { CodexModelSelection } from "../config.js";

interface WorkerInput {
  request: HarnessRequest;
  network: "host" | "off";
  redactionValues?: string[];
  model: CodexModelSelection;
}

function privateProgress(path: string, event: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile() || (fstatSync(fd).mode & 0o077) !== 0)
      throw new Error("Worker progress file is not a restricted regular file");
    appendFileSync(fd, `${JSON.stringify(event)}\n`);
  } finally {
    closeSync(fd);
  }
}

function redact(value: string, secrets: string[]): string {
  let result = value.replace(
    /\b(?:gh[pousr]_|github_pat_|sk-)[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED]",
  );
  for (const secret of secrets)
    if (secret.length) result = result.split(secret).join("[REDACTED]");
  return result;
}

function progressEvent(
  event: ThreadEvent,
  attemptId: string,
  secrets: string[],
  commandOffsets: Map<string, number>,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    eventId: randomUUID(),
    at: new Date().toISOString(),
    attemptId,
    operation: event.type,
  };
  if (event.type === "turn.completed") base.usage = event.usage;
  if (event.type === "turn.failed")
    base.detail = redact(event.error.message, secrets);
  if (event.type === "error") base.detail = redact(event.message, secrets);
  if (
    event.type === "item.started" ||
    event.type === "item.updated" ||
    event.type === "item.completed"
  ) {
    base.itemId = event.item.id;
    base.itemType = event.item.type;
    if (event.item.type === "command_execution") {
      base.exitCode = event.item.exit_code;
      base.status = event.item.status;
      const output = event.item.aggregated_output;
      const previous = commandOffsets.get(event.item.id) ?? 0;
      const complete =
        event.type === "item.completed"
          ? output.length
          : output.lastIndexOf("\n") + 1;
      if (complete > previous)
        base.detail = redact(output.slice(previous, complete), secrets);
      commandOffsets.set(event.item.id, Math.max(previous, complete));
    } else if (event.item.type === "mcp_tool_call") {
      base.tool = `${event.item.server}/${event.item.tool}`;
      base.status = event.item.status;
    } else if (event.item.type === "file_change")
      base.status = event.item.status;
  }
  return base;
}

function writeResult(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("Worker requires input and result paths");
  const {
    request,
    network,
    redactionValues = [],
    model,
  } = JSON.parse(readFileSync(inputPath, "utf8")) as WorkerInput;
  const progressPath = resultPath.replace(
    /\.result\.json$/,
    ".progress.ndjson",
  );
  const codex = new Codex({
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  const thread = codex.startThread({
    workingDirectory: request.worktree,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: network === "host",
    model: model.model,
    modelReasoningEffort: model.reasoningEffort,
  });
  const mediaInstructions = request.item.expectedOutputRoles?.length
    ? `\n\nProduce at least ${request.item.minimumAssetSets ?? 1} complete candidate AssetSets with different content. Put candidate bytes under .factory-media/ and write .factory-assets.json at the checkout root. Use this format-neutral manifest shape, replacing every angle-bracket placeholder with the actual declared role, file, media type, and owned destination: {"sets":[{"id":"candidate-a","members":[{"role":"<expected role>","path":".factory-media/candidate-a/<file>","mediaType":"<declared media type>","destination":"<owned target path>"}],"provenance":{"source":"<source path or generated>","rights":"<basis for repository use>","visibility":"repository","lineage":["<source path or input identity>"]}}]}. Include every expected role in each set. You may add member formatMetadata with a named source and uninterpreted values when an authoritative tool supplies it, set-level relationships with from, toRole, and kind when outputs are related, and production evidence with model, tool, request, or parameters when those values are actually supplied. Do not invent metadata or tool identities. .factory-media/ and .factory-assets.json are the only staging exceptions to owned paths. Do not write final destinations directly. Candidate files and the manifest are staging outputs; do not commit them. The controller will preserve the exact bytes for human review and selection.\nSource bindings: ${JSON.stringify(request.sourceAssets ?? [])}\nExpected output roles: ${request.item.expectedOutputRoles.join(", ")}`
    : "";
  const inputInstructions =
    request.selectedAssets?.length ||
    request.sourceAssets?.some((source) => source.path)
      ? `\n\nAuthorized read-only asset inputs (files are removed before delivery; do not edit or commit them): ${JSON.stringify(
          {
            selected: request.selectedAssets ?? [],
            privateSources:
              request.sourceAssets?.filter((source) => source.path) ?? [],
          },
        )}`
      : "";
  const prompt = `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${request.item.title}\nGoal: ${request.item.goal}\nAcceptance:\n${request.item.acceptance.join("\n")}\nNon-goals:\n${request.item.nonGoals.join("\n")}\nOwned paths:\n${request.item.ownedPaths.join("\n")}\nBrief:\n${request.item.brief}${mediaInstructions}${inputInstructions}`;
  try {
    const streamed = await thread.runStreamed(prompt);
    let finalResponse = "";
    let usage: unknown = null;
    const commandOffsets = new Map<string, number>();
    let progressLost = false;
    for await (const event of streamed.events) {
      const observation = progressEvent(
        event,
        request.attemptId ?? "",
        redactionValues,
        commandOffsets,
      );
      if (!progressLost)
        try {
          privateProgress(progressPath, observation);
        } catch (error) {
          progressLost = true;
          process.stderr.write(
            `Factory worker progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
      if (
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.item.type === "agent_message"
      )
        finalResponse = event.item.text;
      if (event.type === "turn.completed") usage = event.usage;
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
    }
    const manifest = join(request.worktree, ".factory-assets.json");
    if (
      existsSync(manifest) &&
      (!lstatSync(manifest).isFile() ||
        realpathSync(manifest) !== resolve(manifest))
    )
      throw new Error("AssetSet manifest is not a regular staging file");
    const manifestValue: unknown = existsSync(manifest)
      ? JSON.parse(readFileSync(manifest, "utf8"))
      : undefined;
    if (
      manifestValue !== undefined &&
      (!manifestValue ||
        typeof manifestValue !== "object" ||
        Array.isArray(manifestValue))
    )
      throw new Error("AssetSet manifest must be an object with sets");
    const parsedAssets =
      manifestValue === undefined
        ? undefined
        : parseProducedAssetSets(
            (manifestValue as Record<string, unknown>).sets,
          );
    if (
      request.item.expectedOutputRoles?.length &&
      (!parsedAssets ||
        parsedAssets.length < (request.item.minimumAssetSets ?? 1))
    )
      throw new Error(
        "Media Work Item did not declare the requested complete AssetSets",
      );
    writeResult(resultPath, {
      state: "complete",
      assets: parsedAssets,
      evidence: {
        finalResponse,
        threadId: thread.id,
        usage,
      },
    });
  } catch (error) {
    writeResult(resultPath, {
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
