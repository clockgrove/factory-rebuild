import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseFactoryState } from "../dist/state.js";
import { readState, statePath } from "../dist/state-store.js";
import { workItemReviewObservations } from "../dist/validation.js";

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
  const invalidStart = state();
  invalidStart.work.asset.startedAt = "not-a-time";
  assert.throws(
    () => parseFactoryState(invalidStart, repository, objective),
    /invalid startedAt/,
  );
  const invalidExecutionBase = state();
  invalidExecutionBase.work.asset.executionBaseSha = "not-a-sha";
  assert.throws(
    () => parseFactoryState(invalidExecutionBase, repository, objective),
    /executionBaseSha must be a SHA-1/,
  );
  const invalidIntegratedStart = state();
  invalidIntegratedStart.work.asset.integratedShaAtStart = "not-a-sha";
  assert.throws(
    () => parseFactoryState(invalidIntegratedStart, repository, objective),
    /integratedShaAtStart must be a SHA-1/,
  );
});

test("schemaVersion 1 state rejects legacy source paths and accepts explicit bindings", () => {
  const legacy = state();
  legacy.graph.items[0].sourceAssets = ["assets/source.png"];
  assert.throws(
    () => parseFactoryState(legacy, repository, objective),
    /sourceAssets are invalid/,
  );
  const bound = state();
  bound.graph.items[0].sourceAssets = [
    {
      path: "assets/source.blend",
      role: "mesh",
      mediaType: "application/x-blender",
      visibility: "repository",
    },
  ];
  assert.equal(
    parseFactoryState(bound, repository, objective).graph.items[0]
      .sourceAssets[0].role,
    "mesh",
  );
});

test("legacy attempts expose missing immutable start provenance explicitly", () => {
  const legacy = state();
  legacy.work.asset = {
    status: "running",
    step: "validate",
    attempt: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-24T00:00:00.000Z",
    baseSha: sha,
  };
  const parsed = parseFactoryState(legacy, repository, objective);
  const observations = JSON.parse(
    workItemReviewObservations(parsed, parsed.graph.items[0]),
  );
  assert.equal(observations.attempts[0].executionBaseSha, null);
  assert.deepEqual(observations.attempts[0].integrationAtStart, {
    recorded: false,
  });
});

test("review observations do not confuse a replay base with attempt provenance", () => {
  const replayed = state();
  const replayBase = "c".repeat(40);
  replayed.integratedSha = replayBase;
  replayed.graph.items[0].acceptance = [
    `asset starts at ${sha} independently of peer before either result integrates`,
  ];
  replayed.graph.items.push({
    ...structuredClone(replayed.graph.items[0]),
    id: "peer",
    title: "Create peer",
    acceptance: ["Peer exists"],
    ownedPaths: ["approved/peer.png"],
  });
  replayed.issueByItemId.peer = 44;
  replayed.work.asset = {
    status: "running",
    step: "validate",
    attempt: "11111111-1111-4111-8111-111111111111",
    startedAt: "2026-09-24T00:00:00.000Z",
    executionBaseSha: sha,
    integratedShaAtStart: null,
    baseSha: replayBase,
  };
  replayed.work.peer = {
    status: "done",
    attempt: "22222222-2222-4222-8222-222222222222",
    startedAt: "2026-09-24T00:00:00.010Z",
    executionBaseSha: sha,
    integratedShaAtStart: null,
    baseSha: sha,
    integratedSha: replayBase,
  };
  const parsed = parseFactoryState(replayed, repository, objective);
  const observations = JSON.parse(
    workItemReviewObservations(parsed, parsed.graph.items[0]),
  );
  const attempts = Object.fromEntries(
    observations.attempts.map((attempt) => [attempt.id, attempt]),
  );
  assert.equal(observations.currentIntegratedSha, replayBase);
  assert.equal(attempts.asset.executionBaseSha, sha);
  assert.deepEqual(attempts.asset.integrationAtStart, {
    recorded: true,
    integratedSha: null,
  });
  assert.equal(attempts.asset.integratedSha, null);
  assert.equal(attempts.peer.executionBaseSha, sha);
  assert.deepEqual(attempts.peer.integrationAtStart, {
    recorded: true,
    integratedSha: null,
  });
  assert.equal(attempts.peer.integratedSha, replayBase);
  assert.ok(!("baseSha" in attempts.asset));
});

test("completed replayed item can retain its original worker base in legacy state", () => {
  const completed = state();
  completed.work.asset = {
    status: "done",
    baseSha: "c".repeat(40),
    execution: {
      provider: "local",
      identity: "attempt-1",
      data: {
        request: { item: { id: "asset" }, baseSha: sha },
        handle: {
          identity: "worker-1",
          data: { pid: 123, startTime: "1", resultPath: "/tmp/result" },
        },
        worktree: "/tmp/worktree",
      },
    },
  };
  assert.equal(
    parseFactoryState(completed, repository, objective).work.asset.status,
    "done",
  );
  completed.work.asset.status = "running";
  completed.work.asset.step = "validate";
  assert.throws(
    () => parseFactoryState(completed, repository, objective),
    /active attempt handle is invalid/,
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
