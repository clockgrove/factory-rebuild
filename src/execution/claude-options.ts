import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeWorkerInput } from "./claude.js";

const systemPrompt = [
  "You are an implementation worker controlled by Clockgrove Factory.",
  "Work only in the supplied current working directory and only on paths owned by the Work Item.",
  "Do not commit, push, open or edit issues or pull requests, access GitHub credentials, deploy, or change the current Git HEAD.",
  "Return a concise description of the work performed and stop when the Work Item is complete or cannot be completed safely.",
].join(" ");

/** Build the complete, fail-closed SDK option set from validated adapter config. */
export function claudeQueryOptions(
  input: ClaudeWorkerInput,
  environment: NodeJS.ProcessEnv,
  abortController: AbortController,
): Options {
  const { config, request } = input;
  return {
    abortController,
    cwd: request.worktree,
    model: config.model,
    effort: config.effort,
    tools: [...config.tools],
    allowedTools: [...config.allowedTools],
    permissionMode: config.permissionMode,
    permissionPrompts: "none",
    settingSources: [...config.settingSources],
    maxTurns: config.maxTurns,
    env: { ...environment },
    mcpServers: {},
    strictMcpConfig: true,
    agents: {},
    plugins: [],
    skills: [],
    systemPrompt,
    verbatimPrompts: true,
    thinking: { type: "adaptive" },
    persistSession: false,
  };
}
