import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  claudeAuthenticationValues,
  type ClaudeWorkerInput,
} from "./claude.js";
import {
  harnessFailure,
  privateProgress,
  readProducedAssets,
  redact,
  workItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";
import { claudeQueryOptions } from "./claude-options.js";

function progressEvent(
  message: SDKMessage,
  attemptId: string,
  secrets: string[],
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    eventId: randomUUID(),
    at: new Date().toISOString(),
    attemptId,
    operation: message.type,
  };
  if ("subtype" in message && typeof message.subtype === "string")
    event.subtype = message.subtype;
  if ("session_id" in message && typeof message.session_id === "string")
    event.sessionId = message.session_id;
  if (message.type === "result") {
    event.success = message.subtype === "success" && !message.is_error;
    event.turns = message.num_turns;
    event.usage = message.usage;
    event.modelUsage = message.modelUsage;
    event.totalCostUsd = message.total_cost_usd;
    if (message.subtype !== "success")
      event.detail = redact(message.errors.join("; "), secrets);
  }
  return event;
}

function assertInitialization(
  message: SDKSystemMessage,
  input: ClaudeWorkerInput,
): void {
  const { config, request } = input;
  if (resolve(message.cwd) !== resolve(request.worktree))
    throw new Error("Claude SDK initialized outside the supplied worktree");
  if (message.model !== config.model)
    throw new Error(
      `Claude SDK selected model ${message.model}, expected ${config.model}`,
    );
  if (message.permissionMode !== config.permissionMode)
    throw new Error(
      `Claude SDK selected permission mode ${message.permissionMode}, expected ${config.permissionMode}`,
    );
  if (message.effort !== undefined && message.effort !== config.effort)
    throw new Error(
      `Claude SDK selected effort ${String(message.effort)}, expected ${config.effort}`,
    );
  const configuredTools = new Set(config.tools);
  const unexpectedTool = message.tools.find(
    (tool) => !configuredTools.has(tool),
  );
  if (unexpectedTool)
    throw new Error(`Claude SDK exposed unconfigured tool ${unexpectedTool}`);
  if (message.mcp_servers.length)
    throw new Error("Claude SDK initialized an unconfigured MCP server");
  if (message.plugins.length)
    throw new Error("Claude SDK initialized an unconfigured plugin");
  if (message.skills.length)
    throw new Error("Claude SDK initialized an unconfigured skill");
  if (message.agents?.length)
    throw new Error("Claude SDK initialized an unconfigured agent");
}

function resultError(result: SDKResultMessage): string | undefined {
  if (result.subtype !== "success") return result.errors.join("; ");
  return result.is_error ? result.result : undefined;
}

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("Claude worker requires input and result paths");
  const input = JSON.parse(
    readFileSync(inputPath, "utf8"),
  ) as ClaudeWorkerInput;
  const redactionValues = claudeAuthenticationValues(process.env);
  const progressPath = resultPath.replace(
    /\.result\.json$/,
    ".progress.ndjson",
  );
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  let progressLost = false;
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const stream = query({
      prompt: workItemPrompt(input.request),
      options: claudeQueryOptions(input, process.env, controller),
    });
    let result: SDKResultMessage | undefined;
    let initialization: SDKSystemMessage | undefined;
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        assertInitialization(message, input);
        initialization = message;
      }
      if (message.type === "result") result = message;
      if (!progressLost)
        try {
          privateProgress(
            progressPath,
            progressEvent(
              message,
              input.request.attemptId ?? "",
              redactionValues,
            ),
          );
        } catch (error) {
          progressLost = true;
          process.stderr.write(
            `Factory Claude worker progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
          );
        }
    }
    if (!initialization)
      throw new Error("Claude SDK did not report its initialized session");
    if (!result) throw new Error("Claude SDK ended without a result");
    const error = resultError(result);
    if (error) throw new Error(error);
    const assets = readProducedAssets(input.request);
    writeHarnessResult(resultPath, {
      state: "complete",
      assets,
      evidence: {
        harness: "claude-agent-sdk",
        adapter: input.config.adapter,
        sessionId: result.session_id,
        configuredModel: input.config.model,
        observedModel: initialization.model,
        effort: input.config.effort,
        permissionMode: initialization.permissionMode,
        settingSources: input.config.settingSources,
        finalResponse: result.subtype === "success" ? result.result : "",
        usage: result.usage,
        modelUsage: result.modelUsage,
        totalCostUsd: result.total_cost_usd,
      },
    });
  } catch (error) {
    writeHarnessResult(
      resultPath,
      harnessFailure("claude", error, redactionValues),
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
