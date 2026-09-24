import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Codex } from "@openai/codex-sdk";
import { CodexPlanningModel } from "../dist/compiler.js";
import { validateConfig } from "../dist/config.js";
import { codexWorkerInput } from "../dist/execution/local.js";
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

test("Codex adapter passes phase selections to every planning and review thread", async () => {
  const original = Codex.prototype.startThread;
  const captured = [];
  Codex.prototype.startThread = function (options) {
    captured.push(options);
    return {
      async run(prompt) {
        captured.at(-1).prompt = prompt;
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
      commands: [],
      finalCommands: [],
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
    assert.match(captured[2].prompt, /result identity is a Git tree/);
    assert.match(captured[2].prompt, /stable zero-based index/);
    assert.match(captured[2].prompt, /Work Item Git delta: one/);
    assert.match(captured[2].prompt, /supervisor item delta/);
    assert.match(captured[2].prompt, new RegExp(treeSha));
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
