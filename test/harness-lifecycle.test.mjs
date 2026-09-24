import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthenticationRequiredError } from "../dist/contracts.js";
import { runRegularGraph } from "../dist/delivery/regular-runner.js";
import { statusDocument } from "../dist/diagnostics.js";
import { ClaudeAgentSdkHarness } from "../dist/execution/claude.js";
import { GitHubCopilotSdkHarness } from "../dist/execution/github-copilot.js";
import {
  cleanupCopilotClient,
  stopCopilotClient,
} from "../dist/execution/github-copilot-lifecycle.js";
import { CodexHarness } from "../dist/execution/local.js";

test("Copilot cleanup errors force stop and fail the durable outcome", async () => {
  let forced = 0;
  await assert.rejects(
    stopCopilotClient({
      async stop() {
        return [new Error("runtime remained alive")];
      },
      async forceStop() {
        forced += 1;
      },
    }),
    /reported cleanup errors/,
  );
  assert.equal(forced, 1);
  await assert.rejects(
    stopCopilotClient({
      async stop() {
        throw new Error("graceful stop failed");
      },
      async forceStop() {
        throw new Error("forced stop failed");
      },
    }),
    /graceful and forced cleanup failed/,
  );
  let stopped = 0;
  await assert.rejects(
    cleanupCopilotClient(
      {
        async stop() {
          stopped += 1;
          return [];
        },
        async forceStop() {},
        async deleteSession() {
          return await new Promise(() => undefined);
        },
      },
      {
        sessionId: "session",
        async disconnect() {
          return await new Promise(() => undefined);
        },
      },
      5,
    ),
    /client cleanup failed/,
  );
  assert.equal(stopped, 1);
});

test("built-in harnesses propagate typed local authentication requests", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-harness-auth-"));
  const request = {
    provider: "codex",
    command: "codex login",
  };
  try {
    const cases = [
      {
        root: join(root, "codex", "harness"),
        harness: new CodexHarness(
          join(root, "codex", "empty-gh-config"),
          "host",
          { model: "model", reasoningEffort: "medium" },
        ),
      },
      {
        root: join(root, "claude"),
        harness: new ClaudeAgentSdkHarness(join(root, "claude"), {
          kind: "claude-agent-sdk",
        }),
      },
      {
        root: join(root, "copilot"),
        harness: new GitHubCopilotSdkHarness(join(root, "copilot"), {
          kind: "github-copilot-sdk",
        }),
      },
    ];
    for (const [index, entry] of cases.entries()) {
      mkdirSync(entry.root, { recursive: true });
      const identity = `attempt-${index}`;
      const resultPath = join(entry.root, `${identity}.result.json`);
      writeFileSync(
        resultPath,
        `${JSON.stringify({ state: "failed", error: "Authentication required", authentication: request })}\n`,
      );
      const data = {
        pid: 999_999,
        startTime: "missing",
        requestPath: join(entry.root, `${identity}.request.json`),
        resultPath,
        logPath: join(entry.root, `${identity}.log`),
      };
      await assert.rejects(
        entry.harness.collect({ identity, data }),
        (error) => {
          assert.ok(error instanceof AuthenticationRequiredError);
          assert.deepEqual(error.authentication, request);
          return true;
        },
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("regular execution persists authentication requests for status", async () => {
  const item = {
    id: "auth",
    title: "Authenticate",
    goal: "Exercise the login handoff",
    brief: "Use local login",
    acceptance: ["Authentication is available"],
    nonGoals: ["No fallback"],
    citations: [],
    dependencies: [],
    ownedPaths: ["result.txt"],
    resources: [],
    validation: [],
    sourceAssets: [],
    expectedOutputRoles: [],
    minimumAssetSets: 0,
    requiredLfsRoles: [],
  };
  const state = {
    schemaVersion: 2,
    repository: "example/auth",
    objective: 1,
    runId: "run-auth",
    configDigest: "a".repeat(64),
    baseSha: "b".repeat(40),
    graph: { objective: 1, baseSha: "b".repeat(40), items: [item] },
    issueByItemId: { auth: 2 },
    work: { auth: { status: "pending" } },
  };
  const request = { provider: "codex", command: "codex login" };
  const driver = {
    async availableSlots() {
      return 1;
    },
    async start(input) {
      return { provider: "local", identity: input.attemptId };
    },
    async observe() {
      return { state: "failed", authentication: request };
    },
    async cancel() {},
    async collect() {
      throw new AuthenticationRequiredError(
        "Authentication required for codex",
        request,
      );
    },
  };
  await assert.rejects(
    runRegularGraph({
      config: {
        checkout: "/unused",
        execution: { concurrency: 1 },
      },
      objective: 1,
      objectiveBody: "",
      root: "/unused",
      state,
      driver,
      delivery: {},
      contentStore: {},
      github: {},
      planningModel: {},
      save() {},
      active: new Map(),
      cancelled: () => false,
    }),
    /Authentication required for codex/,
  );
  assert.equal(state.work.auth.status, "failed");
  assert.deepEqual(state.work.auth.authentication, request);
  const status = statusDocument(state, state.repository, 1, "regular", [], 1);
  assert.deepEqual(status.work[0].authentication, request);
});
