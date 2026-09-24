import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { HarnessRequest } from "../contracts.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { CodexModelSelection } from "../config.js";
import {
  authenticationFailure,
  privateProgress,
  readProducedAssets,
  redact,
  workItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";

interface WorkerInput {
  request: HarnessRequest;
  network: "host" | "off";
  allowedSecretNames?: string[];
  model: CodexModelSelection;
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

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("Worker requires input and result paths");
  const {
    request,
    network,
    allowedSecretNames = [],
    model,
  } = JSON.parse(readFileSync(inputPath, "utf8")) as WorkerInput;
  const redactionValues = allowedSecretNames
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value));
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
  const prompt = workItemPrompt(request);
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
    const parsedAssets = readProducedAssets(request);
    writeHarnessResult(resultPath, {
      state: "complete",
      assets: parsedAssets,
      evidence: {
        finalResponse,
        threadId: thread.id,
        usage,
      },
    });
  } catch (error) {
    writeHarnessResult(
      resultPath,
      authenticationFailure("codex", error) ?? {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      },
    );
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
