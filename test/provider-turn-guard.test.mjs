import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  ProviderTurnGuard,
  ProviderTurnTimeoutError,
} from "../dist/provider-turn.js";

test("active callback waits retain their timeout after asynchronous progress", {
  timeout: 2_000,
}, async () => {
  const turn = new ProviderTurnGuard(100);
  let progressed = false;
  let progressedAt;
  const progress = setTimeout(() => {
    progressed = true;
    progressedAt = Date.now();
    turn.progress();
  }, 60);
  try {
    await assert.rejects(
      turn.race(new Promise(() => undefined)),
      ProviderTurnTimeoutError,
    );
    assert.equal(progressed, true);
    assert.equal(turn.signal.aborted, true);
    assert.ok(turn.signal.reason instanceof ProviderTurnTimeoutError);
    assert.ok(
      Date.now() - progressedAt >= 90,
      "progress extends idle deadline",
    );
  } finally {
    clearTimeout(progress);
    turn.finish();
  }
});

test("all active waits share the same timeout and abort reason after progress", {
  timeout: 2_000,
}, async () => {
  const turn = new ProviderTurnGuard(100);
  const progress = setTimeout(() => turn.progress(), 20);
  try {
    const outcomes = await Promise.allSettled([
      turn.race(new Promise(() => undefined)),
      turn.race(new Promise(() => undefined)),
    ]);
    for (const outcome of outcomes) {
      assert.equal(outcome.status, "rejected");
      assert.equal(outcome.reason, turn.signal.reason);
      assert.ok(outcome.reason instanceof ProviderTurnTimeoutError);
    }
  } finally {
    clearTimeout(progress);
    turn.finish();
  }
});

test("provider rejection before timeout preserves its original error", async () => {
  const turn = new ProviderTurnGuard(100);
  const failure = new Error("original provider failure");
  const operation = delay(20).then(() => {
    turn.progress();
    throw failure;
  });
  try {
    await assert.rejects(turn.race(operation), (error) => error === failure);
    assert.equal(turn.signal.aborted, false);
  } finally {
    turn.finish();
  }
});

test("finish cancels the reset deadline after successful provider completion", async () => {
  const turn = new ProviderTurnGuard(40);
  const operation = delay(10).then(() => {
    turn.progress();
    return "completed";
  });
  assert.equal(await turn.race(operation), "completed");
  turn.finish();
  await delay(80);
  assert.equal(turn.signal.aborted, false);
});
