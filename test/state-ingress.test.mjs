import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseFactoryState } from "../dist/state.js";
import { readState, statePath } from "../dist/state-store.js";

const repository = "example/disposable";
const objective = 42;
const sha = "a".repeat(40);

function state() {
  return {
    schemaVersion: 1,
    repository,
    objective,
    runId: "run-1",
    configDigest: "b".repeat(64),
    baseSha: sha,
    graph: {
      objective,
      baseSha: sha,
      items: [
        {
          id: "asset",
          title: "Create asset",
          goal: "Create one asset",
          brief: "Use the fixture",
          acceptance: ["File exists"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "Goal" }],
          dependencies: [],
          ownedPaths: ["approved/image.png"],
          resources: [],
          validation: [
            {
              command: "test -s approved/image.png",
              provenance: "source-declared",
              source: "OBJECTIVE",
            },
          ],
          sourceAssets: [],
          expectedOutputRoles: ["image"],
          minimumAssetSets: 1,
          requiredLfsRoles: [],
        },
      ],
    },
    issueByItemId: { asset: 43 },
    work: { asset: { status: "pending" } },
  };
}

test("persisted state validates identities and graph/work keys before use", () => {
  assert.equal(
    parseFactoryState(state(), repository, objective).work.asset.status,
    "pending",
  );
  const wrongGraph = state();
  wrongGraph.graph.items[0].dependencies = ["missing"];
  assert.throws(
    () => parseFactoryState(wrongGraph, repository, objective),
    /unknown dependency/,
  );
  const wrongWork = state();
  wrongWork.work = { other: { status: "pending" } };
  assert.throws(
    () => parseFactoryState(wrongWork, repository, objective),
    /work\.asset/,
  );
});

test("persisted asset and active process identities fail closed", () => {
  const waiting = state();
  waiting.work.asset = {
    status: "waiting",
    step: "approve-asset",
    assets: [
      {
        id: "candidate-a",
        provenance: {
          source: "source.png",
          rights: "fixture",
          visibility: "repository",
          lineage: ["source.png"],
        },
        evidence: { harnessIdentity: "thread-1", resultDigest: "c".repeat(64) },
        members: [
          {
            role: "image",
            destination: "approved/image.png",
            ref: { digest: "not-a-digest", bytes: 100, mediaType: "image/png" },
          },
        ],
      },
    ],
  };
  assert.throws(
    () => parseFactoryState(waiting, repository, objective),
    /content digest/,
  );
  const running = state();
  running.work.asset = {
    status: "running",
    step: "execute",
    baseSha: sha,
    execution: {
      provider: "local",
      identity: "attempt-1",
      data: {
        request: { item: { id: "asset" }, baseSha: sha },
        handle: {
          identity: "worker-1",
          data: { pid: "bad", startTime: "1", resultPath: "/tmp/result" },
        },
        worktree: "/tmp/worktree",
      },
    },
  };
  assert.throws(
    () => parseFactoryState(running, repository, objective),
    /active attempt handle/,
  );
});

test("state ingress rejects an attempt handle pointing outside Factory state", () => {
  const root = mkdtempSync(join(tmpdir(), "factory-state-ingress-"));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  try {
    const value = state();
    value.work.asset = {
      status: "running",
      step: "execute",
      baseSha: sha,
      execution: {
        provider: "local",
        identity: "attempt-1",
        data: {
          request: { item: { id: "asset" }, baseSha: sha },
          worktree: "/tmp/foreign-worktree",
          handle: {
            identity: "worker-1",
            data: {
              pid: 123,
              startTime: "1",
              requestPath: "/tmp/request",
              resultPath: "/tmp/result",
              logPath: "/tmp/log",
            },
          },
        },
      },
    };
    const path = statePath(repository, objective);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
    assert.throws(
      () => readState(repository, objective),
      /outside Factory state/,
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
