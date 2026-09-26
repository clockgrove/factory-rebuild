const scenario = process.env.FACTORY_SCRIPTED_PROVIDER_SCENARIO;
const stall = () => new Promise(() => undefined);

export function query({ options }) {
  let step = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (scenario === "creation") return stall();
      if (scenario === "auth") throw new Error("Not authenticated");
      if (step++ === 0)
        return {
          done: false,
          value: {
            type: "system",
            subtype: "init",
            cwd: options.cwd,
            model: options.model,
            permissionMode: options.permissionMode,
            effort: options.effort,
            tools: [],
            mcp_servers: [],
            plugins: [],
            skills: [],
            agents: [],
          },
        };
      if (scenario === "timeout") return stall();
      if (scenario === "nonterminal") return { done: true };
      return {
        done: false,
        value: {
          type: "result",
          subtype:
            scenario === "failure" ? "error_during_execution" : "success",
          is_error: scenario === "failure",
          errors: ["authoritative provider failure"],
          result: "scripted completion",
          session_id: "scripted-claude",
          usage: {
            input_tokens: 9,
            output_tokens: 4,
            cache_read_input_tokens: 100,
          },
          modelUsage: {},
          total_cost_usd: 0,
        },
      };
    },
    async return() {
      if (scenario === "cleanup") return stall();
      return { done: true };
    },
  };
}

export class CopilotClient {
  async start() {
    if (scenario === "creation") return stall();
  }
  async getAuthStatus() {
    return {
      isAuthenticated: scenario !== "auth",
      statusMessage: "Not authenticated",
      authType: "scripted",
    };
  }
  async createSession(options) {
    const event = (type, data = {}) =>
      options.onEvent({ type, timestamp: new Date().toISOString(), data });
    event("session.start", {
      context: { cwd: options.workingDirectory },
      selectedModel: options.model,
      reasoningEffort: options.reasoningEffort,
    });
    return {
      sessionId: "scripted-copilot",
      async sendAndWait() {
        if (scenario === "timeout") return stall();
        if (scenario === "failure") {
          event("session.error", { message: "authoritative provider failure" });
          return;
        }
        if (scenario !== "nonterminal") event("session.idle");
        event("session.shutdown", {
          conversationTokens: 123,
          currentModel: options.model,
        });
        return { data: { content: "scripted completion" } };
      },
      async abort() {},
      async disconnect() {},
    };
  }
  async deleteSession() {}
  async stop() {
    return scenario === "cleanup"
      ? [new Error("scripted cleanup failure")]
      : [];
  }
  async forceStop() {}
}
