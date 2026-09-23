import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DiagnosticEmitter,
  diagnosticPath,
  readDiagnostics,
  redactDiagnosticDetail,
} from "../dist/diagnostics.js";
import { validateTree } from "../dist/validation.js";
import { createTarget } from "./support/integration-fixture.mjs";

test("private diagnostics redact secrets and validation preserves command output", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-diagnostics-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    const target = createTarget(root);
    const emitter = new DiagnosticEmitter("example/diagnostics", 1, [
      "private-credential",
    ]);
    emitter.emit({
      operation: "test",
      outcome: "failed",
      detail:
        "Authorization: Bearer abc123 private-credential ghp_abcdefghijklmnopqrstuvwxyz",
    });
    const entries = readDiagnostics("example/diagnostics", 1);
    assert.equal(entries.length, 1);
    assert.doesNotMatch(
      JSON.stringify(entries),
      /private-credential|abc123|ghp_abcdefghijklmnopqrstuvwxyz/,
    );
    assert.match(entries[0].detail, /REDACTED/);
    assert.equal(
      statSync(diagnosticPath("example/diagnostics", 1)).mode & 0o777,
      0o600,
    );
    const tree = execFileSync(
      "git",
      ["-C", target.checkout, "rev-parse", "HEAD^{tree}"],
      { encoding: "utf8" },
    ).trim();
    const observed = [];
    validateTree(
      target.checkout,
      join(root, "validation"),
      target.baseSha,
      tree,
      ["printf 'visible output\\n'"],
      (entry) => observed.push(entry),
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0].passed, true);
    assert.match(observed[0].output, /visible output/);
    assert.equal(redactDiagnosticDetail("sk-abcdefghijklmnop"), "[REDACTED]");
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
