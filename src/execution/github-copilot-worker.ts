import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import {
  githubCopilotAuthenticationValues,
  type GitHubCopilotWorkerInput,
} from "./github-copilot.js";
import {
  harnessFailure,
  privateProgress,
  readProducedAssets,
  redact,
  workItemPrompt,
  writeHarnessResult,
} from "./harness-support.js";
import {
  githubCopilotClientOptions,
  githubCopilotSessionOptions,
} from "./github-copilot-options.js";
import { cleanupCopilotClient } from "./github-copilot-lifecycle.js";

function progressEvent(
  event: SessionEvent,
  attemptId: string,
  secrets: string[],
): Record<string, unknown> {
  const observation: Record<string, unknown> = {
    eventId: randomUUID(),
    at: event.timestamp,
    attemptId,
    operation: event.type,
  };
  if (event.agentId) observation.agentId = event.agentId;
  if (event.type === "tool.execution_start") {
    observation.tool = event.data.toolName;
    observation.model = event.data.model;
  }
  if (event.type === "session.error")
    observation.detail = redact(event.data.message, secrets);
  if (event.type === "session.shutdown") {
    observation.model = event.data.currentModel;
    observation.tokens = event.data.conversationTokens;
    observation.shutdownType = event.data.shutdownType;
  }
  return observation;
}

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("GitHub Copilot worker requires input and result paths");
  const input = JSON.parse(
    readFileSync(inputPath, "utf8"),
  ) as GitHubCopilotWorkerInput;
  const redactionValues = githubCopilotAuthenticationValues(process.env);
  const progressPath = resultPath.replace(
    /\.result\.json$/,
    ".progress.ndjson",
  );
  let progressLost = false;
  let client: import("@github/copilot-sdk").CopilotClient | undefined;
  let session: import("@github/copilot-sdk").CopilotSession | undefined;
  let outcome: Record<string, unknown> | undefined;
  let sessionStart:
    Extract<SessionEvent, { type: "session.start" }>["data"] | undefined;
  try {
    const { CopilotClient } = await import("@github/copilot-sdk");
    const baseDirectory =
      process.env.COPILOT_HOME ?? join(process.env.HOME ?? "", ".copilot");
    client = new CopilotClient(
      githubCopilotClientOptions(input, process.env, baseDirectory),
    );
    await client.start();
    const authentication = await client.getAuthStatus();
    if (!authentication.isAuthenticated)
      throw new Error(
        authentication.statusMessage ?? "Not authenticated with GitHub Copilot",
      );
    session = await client.createSession({
      ...githubCopilotSessionOptions(input),
      onEvent: (event) => {
        if (event.type === "session.start") sessionStart = event.data;
        if (!progressLost)
          try {
            privateProgress(
              progressPath,
              progressEvent(
                event,
                input.request.attemptId ?? "",
                redactionValues,
              ),
            );
          } catch (error) {
            progressLost = true;
            process.stderr.write(
              `Factory GitHub Copilot progress unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
            );
          }
      },
    });
    process.once("SIGTERM", () => void session?.abort().catch(() => undefined));
    const response = await session.sendAndWait(
      { prompt: workItemPrompt(input.request) },
      input.config.timeoutSeconds * 1_000,
    );
    if (!sessionStart)
      throw new Error("GitHub Copilot SDK did not report session startup");
    if (sessionStart.context?.cwd !== input.request.worktree)
      throw new Error(
        "GitHub Copilot SDK initialized outside the supplied worktree",
      );
    if (sessionStart.selectedModel !== input.config.model)
      throw new Error(
        `GitHub Copilot SDK selected model ${String(sessionStart.selectedModel)}, expected ${input.config.model}`,
      );
    if (
      sessionStart.reasoningEffort !== undefined &&
      sessionStart.reasoningEffort !== input.config.reasoningEffort
    )
      throw new Error(
        `GitHub Copilot SDK selected reasoning effort ${sessionStart.reasoningEffort}, expected ${input.config.reasoningEffort}`,
      );
    const assets = readProducedAssets(input.request);
    outcome = {
      state: "complete",
      assets,
      evidence: {
        harness: "github-copilot-sdk",
        adapter: input.config.adapter,
        sessionId: session.sessionId,
        configuredModel: input.config.model,
        observedModel: sessionStart.selectedModel,
        reasoningEffort: input.config.reasoningEffort,
        availableTools: input.config.availableTools,
        authenticationType: authentication.authType,
        finalResponse: response?.data.content ?? "",
      },
    };
  } catch (error) {
    outcome = harnessFailure("github-copilot", error, redactionValues);
    process.exitCode = 1;
  } finally {
    try {
      if (client) await cleanupCopilotClient(client, session);
    } catch (error) {
      outcome = harnessFailure("github-copilot", error, redactionValues);
      process.exitCode = 1;
    }
  }
  if (!outcome) throw new Error("GitHub Copilot worker produced no outcome");
  writeHarnessResult(resultPath, outcome);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
