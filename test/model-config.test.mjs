import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import * as configModule from "../dist/config.js";
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
import {
  authenticationFailure,
  harnessFailure,
  parseAuthenticationRequest,
  workItemPrompt,
} from "../dist/execution/harness-support.js";
import { FACTORY_VERSION } from "../dist/package-metadata.js";
import * as publicModule from "../dist/index.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const {
  CLAUDE_AGENT_SDK_ADAPTER_IDENTITY,
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  factoryConfigDigest,
  GITHUB_COPILOT_SDK_ADAPTER_IDENTITY,
  validateConfig,
} = configModule;
const { compose, composeWithLocalHarness } = publicModule;
const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

test("provider client identity tracks the exact package version", () => {
  assert.equal(FACTORY_VERSION, packageVersion);
});

test("shared worker prompt preserves exact controller validation constraints", () => {
  const checks = [
    {
      command: "grep -qx 'literal without punctuation' proof/exact.txt",
      provenance: "source-declared",
      source: "OBJECTIVE",
    },
    {
      command: "npm test",
      provenance: "base-observed",
      source: "package.json",
    },
  ];
  const prompt = workItemPrompt({
    worktree: "/tmp/factory-shared-prompt-test",
    item: {
      id: "shared-prompt",
      title: "Preserve exact validation",
      goal: "Create the exact literal output.",
      acceptance: ["The literal is exact."],
      nonGoals: ["Do not publish."],
      citations: [{ path: "OBJECTIVE" }],
      dependencies: [],
      ownedPaths: ["proof/exact.txt"],
      validation: checks,
      brief: "Make only the bounded change.",
    },
  });

  assert.match(prompt, /Controller-run validation constraints/);
  assert.match(prompt, /Factory, not the worker, executes/);
  for (const check of checks) assert.ok(prompt.includes(JSON.stringify(check)));
});

test("package root exports only role-specific model defaults", () => {
  assert.equal(
    Object.hasOwn(publicModule, "DEFAULT_CODEX_MODEL_SELECTION"),
    false,
  );
  assert.equal(
    publicModule.DEFAULT_PLANNER_MODEL_SELECTION,
    DEFAULT_PLANNER_MODEL_SELECTION,
  );
  assert.equal(
    publicModule.DEFAULT_REVIEWER_MODEL_SELECTION,
    DEFAULT_REVIEWER_MODEL_SELECTION,
  );
  assert.equal(
    publicModule.DEFAULT_WORKER_MODEL_SELECTION,
    DEFAULT_WORKER_MODEL_SELECTION,
  );
});

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
    const validated = validateConfig(config);
    assert.deepEqual(validated.planning, config.planning);
    assert.deepEqual(validated.execution.harness, config.execution.harness);

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
    "copilot",
  );
  assert.deepEqual(
    harnessFailure("codex", new Error("provider echoed durable-secret-value"), [
      "durable-secret-value",
    ]),
    { state: "failed", error: "provider echoed [REDACTED]" },
  );
  assert.equal(
    authenticationFailure(
      "github-copilot",
      new Error("No authentication active"),
    ).authentication.command,
    "copilot",
  );
  assert.deepEqual(
    parseAuthenticationRequest({ provider: "codex", command: "codex login" }),
    { provider: "codex", command: "codex login" },
  );
  assert.equal(parseAuthenticationRequest({ provider: "codex" }), undefined);
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

test("Claude adapter configuration is exact, isolated, and bound to the pinned SDK", async () => {
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
      reasoningEffort: "high",
      permissionMode: "acceptEdits",
      session: "new-per-attempt",
      settingSources: [],
      tools: ["Read", "Edit", "Write", "Glob", "Grep"],
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep"],
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
    assert.equal(
      environment.CLAUDE_AGENT_SDK_CLIENT_APP,
      `clockgrove-factory/${packageVersion}`,
    );
    const queryOptions = claudeQueryOptions(
      workerInput,
      environment,
      new AbortController(),
    );
    assert.equal(queryOptions.cwd, target.checkout);
    assert.equal(queryOptions.model, "claude-explicit-model");
    assert.equal(queryOptions.effort, "high");
    assert.equal(queryOptions.permissionPrompts, "host");
    assert.deepEqual(queryOptions.allowedTools, []);
    assert.equal(queryOptions.persistSession, false);
    assert.equal(queryOptions.strictMcpConfig, true);
    assert.deepEqual(queryOptions.settingSources, []);
    assert.deepEqual(queryOptions.plugins, []);
    assert.deepEqual(queryOptions.agents, {});
    assert.deepEqual(queryOptions.skills, []);
    assert.deepEqual(queryOptions.mcpServers, {});
    assert.equal(queryOptions.env.GH_TOKEN, undefined);
    const permission = {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
      requestId: "request-1",
    };
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Read",
          { file_path: join(target.checkout, "README.md") },
          permission,
        )
      ).behavior,
      "allow",
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Read",
          { file_path: join(root, "outside.txt") },
          permission,
        )
      ).behavior,
      "deny",
    );
    symlinkSync(root, join(target.checkout, "escape"));
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Write",
          { file_path: join(target.checkout, "escape", "outside.txt") },
          permission,
        )
      ).behavior,
      "deny",
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Write",
          {
            file_path: `${target.checkout}/escape/../outside-via-parent.txt`,
          },
          permission,
        )
      ).behavior,
      "deny",
    );
    symlinkSync(
      join(root, "missing-outside.txt"),
      join(target.checkout, "dangling"),
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Write",
          { file_path: join(target.checkout, "dangling") },
          permission,
        )
      ).behavior,
      "deny",
    );
    assert.equal(
      (
        await queryOptions.canUseTool(
          "Glob",
          { path: target.checkout, pattern: "../*.ts" },
          permission,
        )
      ).behavior,
      "deny",
    );
    assert.equal(
      (await queryOptions.canUseTool("Bash", { command: "true" }, permission))
        .behavior,
      "deny",
    );
    const preToolUse = queryOptions.hooks.PreToolUse[0].hooks[0];
    const hookContext = {
      session_id: "session",
      transcript_path: join(root, "transcript.jsonl"),
      cwd: target.checkout,
      permission_mode: "acceptEdits",
      hook_event_name: "PreToolUse",
      tool_use_id: "tool-1",
    };
    assert.equal(
      (
        await preToolUse(
          {
            ...hookContext,
            tool_name: "Write",
            tool_input: { file_path: join(target.checkout, "safe.txt") },
          },
          "tool-1",
          { signal: permission.signal },
        )
      ).hookSpecificOutput.permissionDecision,
      "allow",
    );
    assert.equal(
      (
        await preToolUse(
          {
            ...hookContext,
            tool_name: "Glob",
            tool_input: { path: target.checkout, pattern: "../*.ts" },
          },
          "tool-1",
          { signal: permission.signal },
        )
      ).hookSpecificOutput.permissionDecision,
      "deny",
    );

    const wrongAdapter = structuredClone(config);
    wrongAdapter.execution.harness.adapter =
      "@anthropic-ai/claude-agent-sdk@latest";
    assert.throws(
      () => validateConfig(wrongAdapter),
      /adapter is not the pinned Claude SDK/,
    );
    const leakedProviderField = structuredClone(config);
    leakedProviderField.execution.harness.effort = "medium";
    assert.throws(
      () => validateConfig(leakedProviderField),
      /effort is unsupported/,
    );
    const unexpectedTool = structuredClone(config);
    unexpectedTool.execution.harness.allowedTools.push("WebSearch");
    assert.throws(
      () => validateConfig(unexpectedTool),
      /allowedTools must be a subset/,
    );
    const shellTool = structuredClone(config);
    shellTool.execution.harness.tools.push("Bash");
    shellTool.execution.harness.allowedTools.push("Bash");
    assert.throws(
      () => validateConfig(shellTool),
      /supports only Read, Edit, Write, Glob, and Grep/,
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
  const previousCopilotHome = process.env.COPILOT_HOME;
  const previousGitHub = process.env.GH_TOKEN;
  process.env.XDG_STATE_HOME = join(root, "state");
  process.env.COPILOT_GITHUB_TOKEN = "copilot-test-secret";
  process.env.GITHUB_COPILOT_API_TOKEN = "copilot-endpoint-secret";
  process.env.COPILOT_MODEL = "ambient-model-must-not-leak";
  process.env.COPILOT_HOME = join(root, "developer-copilot-home");
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
    assert.equal(
      environment.COPILOT_HOME,
      join(root, "developer-copilot-home"),
    );
    const clientOptions = githubCopilotClientOptions(
      workerInput,
      environment,
      join(root, "copilot-home"),
    );
    assert.equal(clientOptions.mode, "empty");
    assert.equal(clientOptions.useLoggedInUser, true);
    assert.equal(clientOptions.workingDirectory, target.checkout);
    assert.deepEqual(clientOptions.builtinPluginDirectories, []);
    assert.equal(clientOptions.clientInfo.applicationVersion, packageVersion);
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
    symlinkSync(root, join(target.checkout, "escape"));
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "write",
            fileName: join(target.checkout, "escape", "outside.txt"),
            intention: "write",
            diff: "",
            canOfferSessionApproval: false,
          },
          { sessionId: "test" },
        )
      ).kind,
      "reject",
    );
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "write",
            fileName: `${target.checkout}/escape/../outside-via-parent.txt`,
            intention: "write",
            diff: "",
            canOfferSessionApproval: false,
          },
          { sessionId: "test" },
        )
      ).kind,
      "reject",
    );
    symlinkSync(
      join(root, "missing-copilot-outside.txt"),
      join(target.checkout, "dangling"),
    );
    assert.equal(
      (
        await sessionOptions.onPermissionRequest(
          {
            kind: "write",
            fileName: join(target.checkout, "dangling"),
            intention: "write",
            diff: "",
            canOfferSessionApproval: false,
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
    for (const tool of [
      "bash",
      "*",
      "builtin:*",
      "mcp:*",
      "custom:*",
      "view:*",
      "future-tool",
    ]) {
      const unsafeTool = structuredClone(config);
      unsafeTool.execution.harness.availableTools.push(tool);
      assert.throws(
        () => validateConfig(unsafeTool),
        /supports only view, create, edit, grep, and glob/,
      );
    }
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
    if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previousCopilotHome;
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
        "Edit",
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
      reasoningEffort: "xhigh",
      permissionMode: "dontAsk",
      session: "new-per-attempt",
      settingSources: [],
      tools: ["Read", "Edit"],
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

test("install resolves Factory-owned role defaults and isolates one-role overrides", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-model-defaults-"));
  const scenarios = [
    {
      name: "defaults",
      flags: [],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "planner",
      flags: ["--planning-model", "planner-choice"],
      planner: { model: "planner-choice", reasoningEffort: "medium" },
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "reviewer",
      flags: ["--review-reasoning", "high"],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      worker: DEFAULT_WORKER_MODEL_SELECTION,
    },
    {
      name: "worker",
      flags: ["--worker-model", "worker-choice"],
      planner: DEFAULT_PLANNER_MODEL_SELECTION,
      reviewer: DEFAULT_REVIEWER_MODEL_SELECTION,
      worker: { model: "worker-choice", reasoningEffort: "medium" },
    },
  ];
  try {
    for (const scenario of scenarios) {
      const scenarioRoot = join(root, scenario.name);
      mkdirSync(scenarioRoot, { recursive: true });
      const target = createTarget(scenarioRoot);
      const configPath = join(scenarioRoot, "config", "factory.json");
      execFileSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "../dist/cli.js"),
          "install",
          "--repository",
          `example/model-${scenario.name}`,
          "--checkout",
          target.checkout,
          "--concurrency",
          "1",
          ...scenario.flags,
          "--config",
          configPath,
        ],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            XDG_STATE_HOME: join(scenarioRoot, "state"),
          },
        },
      );
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      assert.deepEqual(config.planning.planner, scenario.planner);
      assert.deepEqual(config.planning.reviewer, scenario.reviewer);
      assert.deepEqual(config.execution.harness, {
        kind: "codex-sdk",
        ...scenario.worker,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Codex adapter passes phase selections to every planning and review thread", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  Codex.prototype.startThread = function (options) {
    const index = captured.length;
    const entry = { options, id: `thread-${index}` };
    captured.push(entry);
    return {
      get id() {
        return entry.id;
      },
      async runStreamed(prompt, options) {
        entry.prompt = prompt;
        entry.outputSchema = options.outputSchema;
        async function* events() {
          yield { type: "thread.started", thread_id: entry.id };
          yield { type: "turn.started" };
          yield {
            type: "item.started",
            item: {
              id: `command-${index}`,
              type: "command_execution",
              command: "printf private-command-marker",
              aggregated_output: "private-command-output",
              status: "in_progress",
            },
          };
          yield {
            type: "item.completed",
            item: {
              id: `message-${index}`,
              type: "agent_message",
              text:
                index === 0
                  ? JSON.stringify({ result: "compiled" })
                  : JSON.stringify({ findings: [] }),
            },
          };
          yield {
            type: "turn.completed",
            usage: {
              input_tokens: 100 + index,
              cached_input_tokens: 50 + index,
              cache_write_input_tokens: 3 + index,
              output_tokens: 20 + index,
              reasoning_output_tokens: 7 + index,
            },
          };
        }
        return { events: events() };
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
    const observations = [];
    const invocation = (phase, ordinal) => ({
      invocationId: `${phase}-${ordinal}`,
      phase,
      ordinal,
      observe: (event) => observations.push(event),
    });
    await model.generateStructured({
      objective: "private-objective-marker",
      baseSha,
      sources: [{ path: "OBJECTIVE", content: "private-source-marker" }],
      schema: { type: "object" },
      invocation: invocation("compile", 0),
    });
    await model.reviewGraph({
      objective: "Objective",
      baseSha,
      sources: [
        {
          path: "OBJECTIVE",
          content: "# Objective\n\n## Acceptance\nRequired",
        },
        {
          path: "docs/plan.md",
          heading: "Wave 0",
          content: "## Wave 0\nCanonical plan",
        },
        {
          path: "OBJECTIVE",
          content: "# Objective\n\n## Boundaries\nNo deployment",
        },
      ],
      graph: { objective: 1, baseSha, items: [] },
      commands: [],
      finalCommands: [],
      invocation: invocation("graph-review", 0),
    });
    const treeSha = "b".repeat(40);
    await model.reviewResult({
      criteria: ["Criterion"],
      baseSha,
      treeSha,
      sources: [],
      change: "{}",
      evidence: [
        {
          path: "Work Item Git delta: one",
          content: "supervisor item delta",
        },
      ],
      commands: [
        {
          index: 0,
          command: "test -f result.txt",
          passed: true,
          exitCode: 0,
          treeSha,
        },
      ],
      invocation: invocation("result-review", 0),
    });
    assert.deepEqual(
      captured.map(({ options }) => ({
        model: options.model,
        modelReasoningEffort: options.modelReasoningEffort,
      })),
      [
        { model: "planner-choice", modelReasoningEffort: "high" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
        { model: "reviewer-choice", modelReasoningEffort: "medium" },
      ],
    );
    assert.deepEqual(
      captured[1].outputSchema.properties.findings.items.properties.source,
      { type: "string", enum: ["OBJECTIVE", "docs/plan.md"] },
    );
    assert.match(
      captured[1].prompt,
      /set source to exactly one value from this supplied-path JSON list/,
    );
    assert.match(captured[1].prompt, /\["OBJECTIVE","docs\/plan\.md"\]/);
    assert.match(
      captured[1].prompt,
      /Do not append a heading, section name, separator, or explanation/,
    );
    assert.match(captured[1].prompt, /return exactly \{"findings":\[\]\}/);
    assert.match(
      captured[1].prompt,
      /do not emit advisory observations, confirmations, or speculative questions/,
    );
    assert.equal(
      captured[1].outputSchema.properties.findings.description,
      "Return [] exactly when the plan has no material source-grounded defect.",
    );
    assert.match(captured[2].prompt, /result identity is a Git tree/);
    assert.match(captured[2].prompt, /stable zero-based index/);
    assert.match(captured[2].prompt, /Work Item Git delta: one/);
    assert.match(captured[2].prompt, /supervisor item delta/);
    assert.match(captured[2].prompt, new RegExp(treeSha));
    for (const [index, phase] of [
      "compile",
      "graph-review",
      "result-review",
    ].entries()) {
      const events = observations.filter((event) => event.phase === phase);
      assert.equal(events[0].type, "started");
      assert.ok(events.some((event) => event.type === "progress"));
      assert.ok(
        events.some(
          (event) =>
            event.providerItemType === "command_execution" &&
            event.tool === "shell",
        ),
      );
      assert.equal(events.at(-1).type, "completed");
      assert.equal(events.at(-1).providerThreadId, `thread-${index}`);
      assert.deepEqual(events.at(-1).usage, {
        inputTokens: 100 + index,
        cachedInputTokens: 50 + index,
        cacheWriteInputTokens: 3 + index,
        outputTokens: 20 + index,
        reasoningOutputTokens: 7 + index,
      });
      assert.equal(events.at(-1).usageAvailable, true);
      assert.equal(
        events[0].model,
        index ? "reviewer-choice" : "planner-choice",
      );
      assert.equal(events[0].reasoningEffort, index ? "medium" : "high");
      assert.equal(typeof events[0].promptDigest, "string");
      assert.equal(typeof events[0].sourcePacketDigest, "string");
    }
    assert.doesNotMatch(
      JSON.stringify(observations),
      /private-objective-marker|private-source-marker|supervisor item delta/,
    );
    assert.doesNotMatch(
      JSON.stringify(observations),
      /private-command-marker|private-command-output/,
    );
  } finally {
    Codex.prototype.startThread = original;
  }
});

test("Codex adapter reports unavailable usage, malformed output, and provider failure", async () => {
  const original = Codex.prototype.startThread;
  let call = 0;
  Codex.prototype.startThread = function () {
    const index = call++;
    if (index === 3) throw new Error("provider capacity unavailable");
    return {
      get id() {
        return `failure-thread-${index}`;
      },
      async runStreamed() {
        async function* events() {
          yield {
            type: "thread.started",
            thread_id: `failure-thread-${index}`,
          };
          if (index === 0) {
            yield {
              type: "item.completed",
              item: { id: "bad", type: "agent_message", text: "not json" },
            };
          } else if (index === 1) {
            yield { type: "error", message: "429 rate limit reached" };
          } else {
            yield {
              type: "item.completed",
              item: {
                id: "clean",
                type: "agent_message",
                text: JSON.stringify({ findings: [] }),
              },
            };
          }
        }
        return { events: events() };
      },
    };
  };
  try {
    const model = new CodexPlanningModel(
      "/tmp/model-config-test",
      { model: "planner-choice", reasoningEffort: "high" },
      { model: "reviewer-choice", reasoningEffort: "medium" },
    );
    const malformed = [];
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        schema: { type: "object" },
        invocation: {
          invocationId: "malformed",
          phase: "compile",
          ordinal: 0,
          observe: (event) => malformed.push(event),
        },
      }),
      SyntaxError,
    );
    assert.equal(malformed.at(-1).type, "response-invalid");
    assert.equal(malformed.at(-1).failureClass, "structured-output-parse");
    assert.equal(malformed.at(-1).usageAvailable, false);
    assert.equal(
      malformed.some((event) => event.type === "failed"),
      false,
    );

    const failed = [];
    await assert.rejects(
      model.reviewGraph({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [{ path: "OBJECTIVE", content: "objective" }],
        graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
        commands: [],
        finalCommands: [],
        invocation: {
          invocationId: "provider-failure",
          phase: "graph-review",
          ordinal: 0,
          observe: (event) => failed.push(event),
        },
      }),
      /429 rate limit/,
    );
    assert.equal(failed.at(-1).type, "failed");
    assert.equal(failed.at(-1).failureClass, "provider-rate-limit");
    assert.equal(failed.at(-1).usageAvailable, false);

    const unavailable = [];
    await model.reviewGraph({
      objective: "objective",
      baseSha: "a".repeat(40),
      sources: [{ path: "OBJECTIVE", content: "objective" }],
      graph: { objective: 1, baseSha: "a".repeat(40), items: [] },
      commands: [],
      finalCommands: [],
      invocation: {
        invocationId: "usage-unavailable",
        phase: "graph-review",
        ordinal: 1,
        observe: (event) => unavailable.push(event),
      },
    });
    assert.equal(unavailable.at(-1).type, "completed");
    assert.equal(unavailable.at(-1).usageAvailable, false);
    assert.equal(unavailable.at(-1).usage, undefined);

    const setupFailure = [];
    await assert.rejects(
      model.generateStructured({
        objective: "objective",
        baseSha: "a".repeat(40),
        sources: [],
        schema: { type: "object" },
        invocation: {
          invocationId: "setup-failure",
          phase: "compile",
          ordinal: 1,
          observe: (event) => setupFailure.push(event),
        },
      }),
      /capacity unavailable/,
    );
    assert.deepEqual(
      setupFailure.map((event) => event.type),
      ["started", "failed"],
    );
    assert.equal(setupFailure.at(-1).failureClass, "provider-capacity");
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
