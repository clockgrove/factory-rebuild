import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DiagnosticEmitter,
  diagnosticPath,
  readDiagnostics,
  readAgentTimeline,
  readWorkerOutput,
  redactDiagnosticDetail,
  StateDiagnostics,
} from "../dist/diagnostics.js";
import { validateTree } from "../dist/validation.js";
import { stateRoot } from "../dist/config.js";
import { createTarget } from "./support/integration-fixture.mjs";

test("private diagnostics redact secrets and validation streams command output", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-diagnostics-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const emitter = new DiagnosticEmitter("example/diagnostics", 1, [
      "private-credential",
      "xy",
      "multi\nline",
    ]);
    emitter.emit({
      operation: "test",
      outcome: "failed",
      detail:
        "Authorization: Bearer abc123 private-credential xy multi\nline ghp_abcdefghijklmnopqrstuvwxyz",
    });
    const entries = readDiagnostics("example/diagnostics", 1);
    assert.equal(entries.length, 1);
    assert.doesNotMatch(
      JSON.stringify(entries),
      /private-credential|abc123|xy|multi|line|ghp_abcdefghijklmnopqrstuvwxyz/,
    );
    assert.match(entries[0].detail, /REDACTED/);
    const splitBearer = {
      operation: "split-bearer",
      outcome: "observed",
    };
    emitter.emitStream(splitBearer, "Authorization: Be");
    emitter.emitStream(splitBearer, "arer abc123", true);
    const splitToken = { operation: "split-token", outcome: "observed" };
    emitter.emitStream(splitToken, "ghp_abc");
    emitter.emitStream(splitToken, "defghijklmnop", true);
    assert.doesNotMatch(
      JSON.stringify(readDiagnostics("example/diagnostics", 1)),
      /Bearer abc123|ghp_abcdefghijklmnop/,
    );
    emitter.emit({ operation: "duplicate", outcome: "observed" });
    emitter.emit({ operation: "duplicate", outcome: "observed" });
    const identities = readDiagnostics("example/diagnostics", 1).map(
      (event) => event.eventId,
    );
    assert.equal(new Set(identities).size, identities.length);
    assert.equal(
      statSync(diagnosticPath("example/diagnostics", 1)).mode & 0o777,
      0o600,
    );
    const pendingTree = "a".repeat(40);
    const stateDiagnostics = new StateDiagnostics(
      emitter,
      {
        schemaVersion: 2,
        repository: "example/diagnostics",
        objective: 1,
        runId: "run-review",
        configDigest: "b".repeat(64),
        baseSha: "c".repeat(40),
        graph: { objective: 1, baseSha: "c".repeat(40), items: [] },
        issueByItemId: {},
        work: {},
        finalAcceptancePending: {
          criterion: "criterion",
          treeSha: pendingTree,
          source: "OBJECTIVE",
          quote: "missing quote",
          question: "Inspect the result",
          detail: "Reviewer evidence was rejected",
          reviewFinding: {
            criterion: "criterion",
            verdict: "pass",
            source: "OBJECTIVE",
            quote: "missing quote",
            detail: "Unsupported",
            question: "",
          },
          reviewRejection: {
            field: "quote",
            reason: "quote-not-found",
          },
        },
      },
      "regular",
      1,
    );
    stateDiagnostics.observe();
    const pendingDiagnostic = readDiagnostics("example/diagnostics", 1).find(
      (event) => event.operation === "objective-acceptance-pending",
    );
    assert.deepEqual(JSON.parse(pendingDiagnostic.detail).reviewRejection, {
      field: "quote",
      reason: "quote-not-found",
    });
    assert.equal(
      JSON.parse(pendingDiagnostic.detail).reviewFinding.quote,
      "missing quote",
    );
    const tree = execFileSync(
      "git",
      ["-C", target.checkout, "rev-parse", "HEAD^{tree}"],
      { encoding: "utf8" },
    ).trim();
    const observed = [];
    let firstOutput;
    const firstOutputSeen = new Promise((resolve) => {
      firstOutput = resolve;
    });
    let finished = false;
    const validation = validateTree(
      target.checkout,
      join(root, "validation"),
      target.baseSha,
      tree,
      [
        "printf 'starting'; sleep 0.2; printf 'private-'; sleep 0.1; printf 'credential\\n'",
      ],
      (entry) => observed.push(entry),
      (entry) => {
        emitter.emitStream(
          {
            operation: "validation-output",
            outcome: "observed",
            metadata: { stream: entry.stream, commandIndex: entry.index },
          },
          entry.output,
          entry.final,
        );
        firstOutput();
      },
    );
    void validation.finally(() => {
      finished = true;
    });
    await firstOutputSeen;
    assert.equal(finished, false);
    assert.ok(
      readDiagnostics("example/diagnostics", 1).some(
        (event) =>
          event.operation === "validation-output" &&
          /startin/.test(event.detail),
      ),
    );
    await validation;
    assert.equal(observed.length, 1);
    assert.equal(observed[0].passed, true);
    assert.match(observed[0].output, /startingprivate-credential/);
    const streamed = readDiagnostics("example/diagnostics", 1).filter(
      (event) => event.operation === "validation-output",
    );
    assert.doesNotMatch(
      JSON.stringify(streamed),
      /private-credential|private-|credential/,
    );
    assert.ok(streamed.some((event) => /REDACTED/.test(event.detail)));
    assert.equal(redactDiagnosticDetail("sk-abcdefghijklmnop"), "[REDACTED]");
    const attemptId = "11111111-1111-4111-8111-111111111111";
    emitter.emit({
      runId: "run-1",
      itemId: "one",
      attemptId,
      operation: "harness",
      outcome: "started",
    });
    const harnessRoot = join(stateRoot("example/diagnostics"), "harness");
    mkdirSync(harnessRoot, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(harnessRoot, `${attemptId}.progress.ndjson`),
      `${JSON.stringify({ at: new Date().toISOString(), attemptId, operation: "turn.completed", usage: { input_tokens: 12 } })}\n`,
      { mode: 0o600 },
    );
    writeFileSync(join(harnessRoot, `${attemptId}.log`), "worker stderr\n", {
      mode: 0o600,
    });
    const timeline = readAgentTimeline("example/diagnostics", 1);
    assert.ok(
      timeline.some(
        (event) =>
          event.workItemId === "one" &&
          event.runId === "run-1" &&
          event.usage?.input_tokens === 12,
      ),
    );
    assert.equal(
      readWorkerOutput("example/diagnostics", attemptId),
      "worker stderr\n",
    );
    assert.throws(
      () =>
        readWorkerOutput(
          "example/diagnostics",
          "22222222-2222-4222-8222-222222222222",
        ),
      /unavailable/,
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
