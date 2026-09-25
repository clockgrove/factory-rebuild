import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import * as configModule from "../dist/config.js";
import { codexWorkerInput } from "../dist/execution/local.js";
import * as publicModule from "../dist/index.js";
import { createTarget, factoryConfig } from "./support/integration-fixture.mjs";

const {
  DEFAULT_PLANNER_MODEL_SELECTION,
  DEFAULT_REVIEWER_MODEL_SELECTION,
  DEFAULT_WORKER_MODEL_SELECTION,
  validateConfig,
} = configModule;

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
  const input = codexWorkerInput({ attemptId: "attempt-1" }, "off", [], {
    model: "worker-choice",
    reasoningEffort: "xhigh",
  });
  assert.deepEqual(input.model, {
    model: "worker-choice",
    reasoningEffort: "xhigh",
  });
});
