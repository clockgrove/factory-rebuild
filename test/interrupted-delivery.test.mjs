import assert from "node:assert/strict";
import test from "node:test";
import { runRegularGraph } from "../dist/delivery/regular-runner.js";

for (const published of [false, true]) {
  test(`interrupted regular delivery refuses without replay (PR known: ${published})`, async () => {
    const work = {
      status: "running",
      step: "deliver",
      attempt: "original-attempt",
      baseSha: "original-base",
      changeRef: "validated-result",
      treeSha: "validated-tree",
      validation: { commands: [] },
      ...(published ? { pullRequest: 42 } : {}),
    };
    const state = {
      runId: "original-run",
      baseSha: "original-base",
      graph: { items: [{ id: "work" }] },
      work: { work },
    };
    const before = structuredClone(state);
    let calls = 0;
    const forbidden = new Proxy(
      {},
      {
        get() {
          calls++;
          throw new Error("unexpected external operation");
        },
      },
    );
    const active = new Map();
    await assert.rejects(
      runRegularGraph({
        config: {},
        objective: 1,
        objectiveBody: "original objective",
        root: "unused",
        state,
        driver: forbidden,
        delivery: forbidden,
        contentStore: forbidden,
        github: forbidden,
        planningModel: forbidden,
        save: () => {
          calls++;
        },
        active,
        cancelled: () => false,
      }),
      /ambiguous active state at deliver; operator direction required; interrupted regular delivery cannot be resumed automatically/,
    );
    assert.deepEqual(state, before);
    assert.equal(calls, 0);
    assert.equal(active.size, 0);
  });
}
