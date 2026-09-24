import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  factoryConfigDigest,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  validateConfig,
} from "../dist/config.js";
import {
  claudeWorkerEnvironment,
  claudeWorkerInput,
} from "../dist/execution/claude.js";
import { claudeQueryOptions } from "../dist/execution/claude-options.js";
import {
  githubCopilotWorkerEnvironment,
  githubCopilotWorkerInput,
} from "../dist/execution/github-copilot.js";
import {
  githubCopilotClientOptions,
  githubCopilotSessionOptions,
} from "../dist/execution/github-copilot-options.js";
import { codexWorkerInput } from "../dist/execution/local.js";
import { authenticationFailure } from "../dist/execution/harness-support.js";
import { compose, composeWithLocalHarness } from "../dist/index.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

test("configuration requires explicit selectable Codex models and reasoning", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-config-"));
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/model-config");
    config.planning.planner = {
      model: "operator/planner-model",
      reasoningEffort: "low",
    };
    config.planning.reviewer = {
      model: "operator/reviewer-model",
      reasoningEffort: "ultra",
    };
    config.execution.harness = {
      kind: "codex-sdk",
      model: "operator/worker-model",
      reasoningEffort: "persistent",
    };
    assert.deepEqual(validateConfig(config).planning, config.planning);

    const missing = structuredClone(config);
    delete missing.planning.reviewer;
    assert.throws(
      () => validateConfig(missing),
      /planning\.reviewer must be an object/,
    );
    const empty = structuredClone(config);
    empty.execution.harness.model = "  ";
    assert.throws(
      () => validateConfig(empty),
      /execution\.harness\.model must be a non-empty string/,
    );
    const unsupported = structuredClone(config);
    unsupported.planning.planner.reasoningEffort = "ambient";
    assert.throws(
      () => validateConfig(unsupported),
      /planning\.planner\.reasoningEffort is unsupported/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing local provider login yields an actionable retry request", () => {
  assert.deepEqual(authenticationFailure("codex", new Error("Not logged in")), {
    state: "failed",
    error:
      "Authentication required for codex; run `codex login` in the developer environment, then retry the Work Item",
    authentication: { provider: "codex", command: "codex login" },
  });
  assert.equal(
    authenticationFailure("claude", new Error("ordinary model failure")),
    undefined,
  );
  assert.equal(
    authenticationFailure("github-copilot", new Error("Authentication failed"))
      .authentication.command,
    "copilot auth login",
  );
  assert.equal(
    authenticationFailure(
      "github-copilot",
      new Error("No authentication active"),
    ).authentication.command,
    "copilot auth login",
  );
});

test("registered harness configuration is explicit and bound to its adapter", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-harness-config-"));
  const previousState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/harness-config");
    config.execution.harness = {
      kind: "registered",
      adapter: "example/scripted@1",
      config: { mode: "deterministic", session: { resume: true } },
    };
    const validated = validateConfig(config);
    assert.equal(validated.execution.harness.adapter, "example/scripted@1");

    const changed = structuredClone(config);
    changed.execution.harness.config.session.resume = false;
    assert.notEqual(factoryConfigDigest(config), factoryConfigDigest(changed));

    const leaked = structuredClone(
      factoryConfig(target.checkout, "example/harness-config"),
    );
    leaked.execution.harness.permissionMode = "ambient";
    assert.throws(
      () => validateConfig(leaked),
      /execution\.harness\.permissionMode is unsupported/,
    );
    assert.throws(
      () => compose(config),
      /is not registered; use composeWithLocalHarness/,
    );

    const harness = {
      capabilities: {
        protocolVersion: 1,
        worktree: "factory-owned-read-write",
        head: "preserve",
        lifecycle: "restart-safe-durable-handle",
        publication: "controller-only",
        assetSets: true,
        authentication: "none",
      },
      async start() {
        return { identity: "unused", data: {} };
      },
      async observe() {
        return { state: "running" };
      },
      async cancel() {},
      async collect() {
        return {};
      },
    };
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/other@1",
          config: config.execution.harness.config,
          harness,
        }),
      /does not match registration/,
    );
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/scripted@1",
          config: { mode: "different" },
          harness,
        }),
      /configuration does not match/,
    );
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/scripted@1",
          config: { ...config.execution.harness.config, invalid: undefined },
          harness,
        }),
      /Registered harness configuration\.invalid must be JSON-safe/,
    );
    assert.ok(
      composeWithLocalHarness(config, {
        identity: "example/scripted@1",
        config: config.execution.harness.config,
        harness,
      }),
    );
    const incompatibleHarness = {
      ...harness,
      capabilities: { ...harness.capabilities, head: "may-move" },
    };
    assert.throws(
      () =>
        composeWithLocalHarness(config, {
          identity: "example/scripted@1",
          config: config.execution.harness.config,
          harness: incompatibleHarness,
        }),
      /does not satisfy the local AgentHarness capability contract/,
    );
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude adapter configuration is exact, isolated, and bound to the pinned SDK", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-config-"));
  const previousState = process.env.XDG_STATE_HOME;
  const previousToken = process.env.ANTHROPIC_API_KEY;
  const previousGitHub = process.env.GH_TOKEN;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.ANTHROPIC_API_KEY = "claude-test-secret";
  process.env.GH_TOKEN = "github-must-not-leak";
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/claude-config");
    config.policy.network = "host";
    config.execution.harness = {
      kind: "claude-agent-sdk",
      adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
      model: "claude-explicit-model",
      effort: "high",
      permissionMode: "acceptEdits",
      session: "new-per-attempt",
      settingSources: [],
      tools: ["Read", "Edit", "Bash"],
      allowedTools: ["Read", "Edit", "Bash"],
      maxTurns: 8,
      authentication: "local",
    };
    const validated = validateConfig(config);
    assert.equal(
      validated.execution.harness.adapter,
      CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
    );
    assert.ok(compose(config));

    const request = {
      attemptId: "attempt-claude",
      objective: 7,
      baseSha: "a".repeat(40),
      worktree: target.checkout,
      item: {
        id: "work",
        title: "Change one file",
        goal: "Exercise adapter configuration",
        acceptance: ["The file changes"],
        nonGoals: ["No publication"],
        ownedPaths: ["src/**"],
        dependencies: [],
        validation: ["true"],
        brief: "Make the deterministic change",
      },
    };
    const workerInput = claudeWorkerInput(request, validated.execution.harness);
    assert.doesNotMatch(JSON.stringify(workerInput), /claude-test-secret/);
    const environment = claudeWorkerEnvironment(join(root, "credentials"));
    assert.equal(environment.ANTHROPIC_API_KEY, "claude-test-secret");
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.HOME, process.env.HOME);
    const queryOptions = claudeQueryOptions(
      workerInput,
      environment,
      new AbortController(),
    );
    assert.equal(queryOptions.cwd, target.checkout);
    assert.equal(queryOptions.model, "claude-explicit-model");
    assert.equal(queryOptions.effort, "high");
    assert.equal(queryOptions.permissionPrompts, "none");
    assert.equal(queryOptions.persistSession, false);
    assert.equal(queryOptions.strictMcpConfig, true);
    assert.deepEqual(queryOptions.settingSources, []);
    assert.deepEqual(queryOptions.plugins, []);
    assert.deepEqual(queryOptions.agents, {});
    assert.deepEqual(queryOptions.skills, []);
    assert.deepEqual(queryOptions.mcpServers, {});
    assert.equal(queryOptions.env.GH_TOKEN, undefined);

    const wrongAdapter = structuredClone(config);
    wrongAdapter.execution.harness.adapter =
      "@anthropic-ai/claude-agent-sdk@latest";
    assert.throws(
      () => validateConfig(wrongAdapter),
      /adapter is not the pinned Claude SDK/,
    );
    const leakedCodexField = structuredClone(config);
    leakedCodexField.execution.harness.reasoningEffort = "medium";
    assert.throws(
      () => validateConfig(leakedCodexField),
      /reasoningEffort is unsupported/,
    );
    const unexpectedTool = structuredClone(config);
    unexpectedTool.execution.harness.allowedTools.push("WebSearch");
    assert.throws(
      () => validateConfig(unexpectedTool),
      /allowedTools must be a subset/,
    );
    const remoteAuthentication = structuredClone(config);
    remoteAuthentication.execution.harness.authentication = "configured-key";
    assert.throws(
      () => validateConfig(remoteAuthentication),
      /authentication must be local/,
    );
    const offline = structuredClone(config);
    offline.policy.network = "off";
    assert.throws(
      () => validateConfig(offline),
      /requires policy\.network host/,
    );
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousToken === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousToken;
    if (previousGitHub === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHub;
    rmSync(root, { recursive: true, force: true });
  }
});

test("GitHub Copilot adapter uses local auth with a bounded empty-mode capability set", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-copilot-config-"));
  const previousState = process.env.XDG_STATE_HOME;
  const previousToken = process.env.COPILOT_GITHUB_TOKEN;
  const previousEndpointToken = process.env.GITHUB_COPILOT_API_TOKEN;
  const previousAmbientModel = process.env.COPILOT_MODEL;
  const previousGitHub = process.env.GH_TOKEN;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.COPILOT_GITHUB_TOKEN = "copilot-test-secret";
  process.env.GITHUB_COPILOT_API_TOKEN = "copilot-endpoint-secret";
  process.env.COPILOT_MODEL = "ambient-model-must-not-leak";
  process.env.GH_TOKEN = "github-publication-token-must-not-leak";
  try {
    const target = createTarget(root);
    const config = factoryConfig(target.checkout, "example/copilot-config");
    config.policy.network = "host";
    config.execution.harness = {
      kind: "github-copilot-sdk",
      adapter: GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
      model: "copilot-explicit-model",
      reasoningEffort: "medium",
      session: "new-per-attempt",
      availableTools: ["view", "create", "edit", "grep", "glob"],
      permissionKinds: ["read", "write"],
      timeoutSeconds: 300,
      authentication: "local",
    };
    const validated = validateConfig(config);
    assert.equal(
      validated.execution.harness.adapter,
      GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
    );
    assert.ok(compose(config));
    const request = {
      attemptId: "attempt-copilot",
      worktree: target.checkout,
      item: {
        id: "work",
        title: "Change one file",
        goal: "Exercise Copilot adapter configuration",
        acceptance: ["The file changes"],
        nonGoals: ["No publication"],
        citations: [],
        ownedPaths: ["src/**"],
        dependencies: [],
        validation: [],
        brief: "Make the deterministic change",
      },
    };
    const workerInput = githubCopilotWorkerInput(
      request,
      validated.execution.harness,
    );
    assert.doesNotMatch(
      JSON.stringify(workerInput),
      /copilot-(?:test|endpoint)-secret/,
    );
    const environment = githubCopilotWorkerEnvironment(
      join(root, "empty-gh-config"),
    );
    assert.equal(environment.COPILOT_GITHUB_TOKEN, "copilot-test-secret");
    assert.equal(
      environment.GITHUB_COPILOT_API_TOKEN,
      "copilot-endpoint-secret",
    );
    assert.equal(environment.GH_TOKEN, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.COPILOT_MODEL, undefined);
    const clientOptions = githubCopilotClientOptions(
      workerInput,
      environment,
      join(root, "copilot-home"),
    );
    assert.equal(clientOptions.mode, "empty");
    assert.equal(clientOptions.useLoggedInUser, true);
    assert.equal(clientOptions.workingDirectory, target.checkout);
    assert.deepEqual(clientOptions.builtinPluginDirectories, []);
    assert.equal(clientOptions.env.GH_TOKEN, undefined);
    const sessionOptions = githubCopilotSessionOptions(workerInput);
    assert.equal(sessionOptions.model, "copilot-explicit-model");
    assert.equal(sessionOptions.reasoningEffort, "medium");
    assert.deepEqual(sessionOptions.availableTools, [
      "view",
      "create",
      "edit",
      "grep",
      "glob",
    ]);
    assert.equal(sessionOptions.enableConfigDiscovery, false);
    assert.equal(sessionOptions.skipCustomInstructions, true);
    assert.equal(sessionOptions.enableSessionStore, false);
    assert.equal(sessionOptions.enableSkills, false);
    assert.equal(sessionOptions.remoteSession, "off");
    assert.deepEqual(
      await sessionOptions.onPermissionRequest(
        {
          kind: "write",
          fileName: join(target.checkout, "src", "one.ts"),
          intention: "write",
          diff: "",
          canOfferSessionApproval: false,
        },
        { sessionId: "test" },
      ),
      { kind: "approve-once" },
    );
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "read",
            path: join(root, "outside"),
            intention: "read",
          },
          { sessionId: "test" },
        )
      ).kind,
      "reject",
    );

    const wrongAdapter = structuredClone(config);
    wrongAdapter.execution.harness.adapter = "@github/copilot-sdk@latest";
    assert.throws(
      () => validateConfig(wrongAdapter),
      /adapter is not the pinned GitHub Copilot SDK/,
    );
    const shell = structuredClone(config);
    shell.execution.harness.availableTools.push("bash");
    assert.throws(() => validateConfig(shell), /cannot expose bash/);
    const unknownPermission = structuredClone(config);
    unknownPermission.execution.harness.permissionKinds.push("shell");
    assert.throws(
      () => validateConfig(unknownPermission),
      /supports only read and write/,
    );
    const offline = structuredClone(config);
    offline.policy.network = "off";
    assert.throws(
      () => validateConfig(offline),
      /requires policy\.network host/,
    );
  } finally {
    if (previousState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousState;
    if (previousToken === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
    else process.env.COPILOT_GITHUB_TOKEN = previousToken;
    if (previousEndpointToken === undefined)
      delete process.env.GITHUB_COPILOT_API_TOKEN;
    else process.env.GITHUB_COPILOT_API_TOKEN = previousEndpointToken;
    if (previousAmbientModel === undefined) delete process.env.COPILOT_MODEL;
    else process.env.COPILOT_MODEL = previousAmbientModel;
    if (previousGitHub === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGitHub;
    rmSync(root, { recursive: true, force: true });
  }
});

test("install flags persist independent planner, reviewer, and worker selections", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-install-"));
  try {
    const target = createTarget(root);
    const configPath = join(root, "config", "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "install",
        "--repository",
        "example/model-install",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--planning-model",
        "planner-choice",
        "--planning-reasoning",
        "high",
        "--review-model",
        "reviewer-choice",
        "--review-reasoning",
        "medium",
        "--worker-model",
        "worker-choice",
        "--worker-reasoning",
        "low",
        "--config",
        configPath,
      ],
      {
        stdio: "ignore",
        env: {
          ...process.env,
          XDG_STATE_HOME: join(root, "state"),
        },
      },
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.planning.planner, {
      model: "planner-choice",
      reasoningEffort: "high",
    });
    assert.deepEqual(config.planning.reviewer, {
      model: "reviewer-choice",
      reasoningEffort: "medium",
    });
    assert.deepEqual(config.execution.harness, {
      kind: "codex-sdk",
      model: "worker-choice",
      reasoningEffort: "low",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install selects the pinned optional Claude adapter without changing planning defaults", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-claude-install-"));
  try {
    const target = createTarget(root);
    const configPath = join(root, "config", "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "install",
        "--repository",
        "example/claude-install",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--harness",
        "claude-agent-sdk",
        "--worker-model",
        "claude-explicit-model",
        "--worker-reasoning",
        "xhigh",
        "--claude-max-turns",
        "12",
        "--claude-permission",
        "dontAsk",
        "--claude-tool",
        "Read",
        "--claude-tool",
        "Bash",
        "--claude-allow-tool",
        "Read",
        "--config",
        configPath,
      ],
      {
        stdio: "ignore",
        env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
      },
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.planning, {
      kind: "codex-sdk",
      planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    });
    assert.deepEqual(config.execution.harness, {
      kind: "claude-agent-sdk",
      adapter: CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
      model: "claude-explicit-model",
      effort: "xhigh",
      permissionMode: "dontAsk",
      session: "new-per-attempt",
      settingSources: [],
      tools: ["Read", "Bash"],
      allowedTools: ["Read"],
      maxTurns: 12,
      authentication: "local",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install selects the pinned optional GitHub Copilot adapter with local auth", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-copilot-install-"));
  try {
    const target = createTarget(root);
    const configPath = join(root, "config", "factory.json");
    execFileSync(
      process.execPath,
      [
        resolve(import.meta.dirname, "../dist/cli.js"),
        "install",
        "--repository",
        "example/copilot-install",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--harness",
        "github-copilot-sdk",
        "--worker-model",
        "copilot-explicit-model",
        "--worker-reasoning",
        "high",
        "--copilot-timeout-seconds",
        "600",
        "--copilot-tool",
        "view",
        "--copilot-tool",
        "edit",
        "--config",
        configPath,
      ],
      {
        stdio: "ignore",
        env: { ...process.env, XDG_STATE_HOME: join(root, "state") },
      },
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.execution.harness, {
      kind: "github-copilot-sdk",
      adapter: GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
      model: "copilot-explicit-model",
      reasoningEffort: "high",
      session: "new-per-attempt",
      availableTools: ["view", "edit"],
      permissionKinds: ["read", "write"],
      timeoutSeconds: 600,
      authentication: "local",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter passes phase selections to every planning and review thread", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  Codex.prototype.startThread = function (options) {
    captured.push(options);
    return {
      async run() {
        return {
          finalResponse:
            captured.length === 1
              ? JSON.stringify({ result: "compiled" })
              : JSON.stringify({ findings: [] }),
        };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const baseSha = "a".repeat(40);
    await model.generateStructured({
      objective: 1,
      baseSha,
      sources: [],
      schema: { type: "object" },
    });
    await model.reviewGraph({
      objective: "Objective",
      baseSha,
      sources: [],
      graph: { objective: 1, baseSha, items: [] },
    });
    await model.reviewResult({
      criteria: ["Criterion"],
      baseSha,
      treeSha: "b".repeat(40),
      sources: [],
      change: "{}",
      commands: [],
    });
    assert.deepEqual(
      captured.map(({ model, modelReasoningEffort }) => ({
        model,
        modelReasoningEffort,
      })),
      [
        { model: "planner-choice", modelReasoningEffort: "high" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
      ],
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex harness private request carries an explicit worker selection", () => {
  const previous = process.env.FACTORY_TEST_SECRET;
  process.env.FACTORY_TEST_SECRET = "request-file-must-not-store-this";
  try {
    const input = codexWorkerInput(
      { attemptId: "attempt-1" },
      "off",
      ["FACTORY_TEST_SECRET"],
      {
        model: "worker-choice",
        reasoningEffort: "xhigh",
      },
    );
    assert.deepEqual(input.model, {
      model: "worker-choice",
      reasoningEffort: "xhigh",
    });
    assert.deepEqual(input.allowedSecretNames, ["FACTORY_TEST_SECRET"]);
    assert.doesNotMatch(
      JSON.stringify(input),
      /request-file-must-not-store-this/,
    );
  } finally {
    if (previous === undefined) delete process.env.FACTORY_TEST_SECRET;
    else process.env.FACTORY_TEST_SECRET = previous;
  }
});
