import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { readState, statePath } from "../dist/state-store.js";
import { readDiagnostics, statusDocument } from "../dist/diagnostics.js";
import {
  createTarget,
  factoryConfig,
  git,
  makeApplication,
  readEvents,
  waitFor,
  waitForFile,
  writeDescriptor,
} from "./support/integration-fixture.mjs";

const objective = 1;

function item(id, options = {}) {
  const command = options.command ?? `test -s ${options.path}`;
  return {
    id,
    title: `Implement ${id}`,
    goal: `Create ${options.path}`,
    acceptance: [`${options.path} has the scripted result`],
    nonGoals: ["No deployment"],
    citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
    dependencies: options.dependencies ?? [],
    ownedPaths: options.ownedPaths ?? [options.path],
    resources: options.resources ?? [],
    validation: [
      { command, provenance: "source-declared", source: "OBJECTIVE" },
    ],
    brief: `Make only the ${id} fixture change.`,
    sourceAssets: options.sourceAssets ?? [],
    expectedOutputRoles: options.expectedOutputRoles ?? [],
    minimumAssetSets: options.minimumAssetSets ?? 0,
    requiredLfsRoles: options.requiredLfsRoles ?? [],
  };
}

function body(commands, finalCommands = commands) {
  return `# Deterministic Objective

## Acceptance
${commands.map((command) => `- \`${command}\``).join("\n")}

## Final validation
${finalCommands.map((command) => `- \`${command}\``).join("\n")}
`;
}

async function fixture(name, callback) {
  const root = mkdtempSync(join(tmpdir(), `factory-${name}-`));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "state");
  try {
    return await callback(root);
  } finally {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

test("regular application path runs a source-grounded concurrent DAG with stable identities", async () => {
  await fixture("regular-integration", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "roots.go");
    const commands = [
      'test "$(cat alpha.txt)" = alpha',
      'test "$(cat beta.txt)" = beta',
      'test "$(cat conflict.txt)" = conflict',
      "test -s joined.txt && grep -q alpha joined.txt && grep -q beta joined.txt",
    ];
    const graph = {
      objective,
      baseSha: target.baseSha,
      items: [
        item("alpha", {
          path: "alpha.txt",
          command: commands[0],
          resources: ["shared-fixture"],
        }),
        item("beta", { path: "beta.txt", command: commands[1] }),
        item("conflict", {
          path: "conflict.txt",
          command: commands[2],
          resources: ["shared-fixture"],
        }),
        item("join", {
          path: "joined.txt",
          command: commands[3],
          dependencies: ["alpha", "beta"],
        }),
      ],
    };
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/regular-integration",
        "regular",
        3,
      ),
      graph,
      objectiveBody: body(commands),
      fakeRoot,
      actions: {
        alpha: { barrier, files: [{ path: "alpha.txt", text: "alpha\n" }] },
        beta: { barrier, files: [{ path: "beta.txt", text: "beta\n" }] },
        conflict: { files: [{ path: "conflict.txt", text: "conflict\n" }] },
        join: {
          files: [{ path: "joined.txt", text: "alpha\nbeta\n" }],
        },
      },
    };
    const { application, eventsPath, github } = makeApplication(descriptor);
    const acceptedPlan = await application.planObjective(objective);
    assert.equal(acceptedPlan.review.status, "clean");
    assert.equal(Object.keys(github.state().issues).length, 0);
    const running = application.runObjective(objective, acceptedPlan);
    await waitFor(
      () => {
        const starts = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return starts.some((event) => event.item === "alpha") &&
          starts.some((event) => event.item === "beta")
          ? starts
          : undefined;
      },
      fakeRoot,
      "independent root attempts",
    );
    const initialStarts = readEvents(eventsPath).filter(
      (event) => event.type === "start",
    );
    assert.deepEqual(
      new Set(initialStarts.map((event) => event.item)),
      new Set(["alpha", "beta"]),
    );
    const inProgress = readState(descriptor.config.repository, objective);
    const snapshot = statusDocument(
      inProgress,
      descriptor.config.repository,
      objective,
      "regular",
    );
    assert.equal(
      snapshot.work.find((work) => work.id === "conflict").blockedReason,
      "resource:alpha",
    );
    assert.equal(
      snapshot.work.find((work) => work.id === "join").blockedReason,
      "dependency:alpha",
    );
    mkdirSync(join(root, "barriers"), { recursive: true });
    writeFileSync(barrier, "go\n");
    const state = await running;
    assert.equal(state.finalValidation.passed, true);
    assert.ok(
      Object.values(state.work).every((work) => work.status === "done"),
    );
    for (const work of Object.values(state.work)) {
      assert.equal(work.validation.treeSha, work.treeSha);
      assert.ok(work.validation.commands.every((check) => check.passed));
    }
    assert.equal(
      state.finalValidation.treeSha,
      git(target.checkout, "rev-parse", `${state.integratedSha}^{tree}`),
    );
    const events = readEvents(eventsPath);
    const joinStart = events.findIndex(
      (event) => event.type === "start" && event.item === "join",
    );
    for (const dependency of ["alpha", "beta"])
      assert.ok(
        joinStart >
          events.findIndex(
            (event) => event.type === "complete" && event.item === dependency,
          ),
      );
    const remote = github.state();
    assert.equal(Object.keys(remote.issues).length, 4);
    assert.equal(Object.keys(remote.pullRequests).length, 4);
    assert.deepEqual(remote.projections.join.dependencies, ["alpha", "beta"]);
    assert.deepEqual(remote.projections.join.citations, [
      { path: "OBJECTIVE", heading: "Acceptance" },
    ]);
    assert.equal(remote.projections.join.validation[0].command, commands[3]);
    const identities = {
      issues: structuredClone(remote.issues),
      pulls: Object.values(remote.pullRequests).map((pull) => pull.number),
      starts: events.filter((event) => event.type === "start").length,
    };
    const rerun = await application.runObjective(objective);
    assert.equal(rerun.integratedSha, state.integratedSha);
    assert.deepEqual(github.state().issues, identities.issues);
    assert.deepEqual(
      Object.values(github.state().pullRequests).map((pull) => pull.number),
      identities.pulls,
    );
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      identities.starts,
    );
    const planning = readEvents(join(fakeRoot, "planning.ndjson"));
    assert.deepEqual(planning[0].sources, [
      "OBJECTIVE",
      "AGENTS.md",
      "README.md",
    ]);
    assert.equal(planning[0].baseSha, target.baseSha);
    const timeline = readDiagnostics(descriptor.config.repository, objective);
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "planning" && event.outcome === "completed",
      ),
    );
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "github-projection" &&
          event.outcome === "completed",
      ),
    );
    for (const id of ["alpha", "beta", "conflict", "join"]) {
      const attempt = state.work[id].attempt;
      assert.ok(
        timeline.some(
          (event) =>
            event.itemId === id &&
            event.attemptId === attempt &&
            event.operation === "execute",
        ),
      );
      assert.ok(
        timeline.some(
          (event) =>
            event.itemId === id &&
            event.operation === "validation-command" &&
            event.outcome === "completed",
        ),
      );
      assert.ok(
        timeline.some(
          (event) => event.itemId === id && event.metadata?.pullRequest,
        ),
      );
    }
    assert.ok(
      timeline.some(
        (event) =>
          event.operation === "objective-finalization" &&
          event.outcome === "completed",
      ),
    );
  });
});

test("application lifecycle reattaches once, cancels owned work, and retries only explicitly", async () => {
  await fixture("lifecycle-restart", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "restart.go");
    const command = 'test "$(cat restart.txt)" = resumed';
    const descriptor = {
      config: factoryConfig(target.checkout, "example/lifecycle-restart"),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("restart", { path: "restart.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot,
      actions: {
        restart: {
          barrier,
          files: [{ path: "restart.txt", text: "resumed\n" }],
        },
      },
    };
    const descriptorPath = join(root, "restart.json");
    writeDescriptor(descriptorPath, descriptor);
    const restartStatePath = statePath(descriptor.config.repository, objective);
    mkdirSync(dirname(restartStatePath), { recursive: true });
    const child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "support", "restart-controller.mjs"),
        descriptorPath,
        String(objective),
      ],
      {
        cwd: join(import.meta.dirname, ".."),
        env: { ...process.env, XDG_STATE_HOME: process.env.XDG_STATE_HOME },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let childOutput = "";
    child.stdout.on("data", (chunk) => (childOutput += chunk));
    child.stderr.on("data", (chunk) => (childOutput += chunk));
    try {
      await waitForFile(
        () => {
          const state = existsSync(restartStatePath)
            ? readState(descriptor.config.repository, objective)
            : undefined;
          return state?.work.restart.execution ? state : undefined;
        },
        restartStatePath,
        "persisted restart handle",
      );
    } catch (error) {
      const detail = `${error.message}; child=${child.exitCode ?? "running"}; output=${childOutput}; events=${JSON.stringify(readEvents(join(fakeRoot, "harness.ndjson")))}`;
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
      throw new Error(detail);
    }
    child.kill("SIGKILL");
    await once(child, "exit");
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const { application, eventsPath, github } = makeApplication(descriptor);
    const resumed = await application.runObjective(objective);
    assert.equal(resumed.finalValidation.passed, true);
    assert.equal(Object.keys(github.state().pullRequests).length, 1);
    assert.equal(
      readEvents(eventsPath).filter(
        (event) => event.type === "start" && event.item === "restart",
      ).length,
      1,
    );
    const restartTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(
      restartTimeline.filter(
        (event) =>
          event.operation === "objective-run" && event.outcome === "started",
      ).length >= 2,
    );
    assert.ok(
      restartTimeline.some(
        (event) =>
          event.operation === "harness" &&
          event.attemptId === resumed.work.restart.attempt,
      ),
    );
  });

  await fixture("lifecycle-cancel", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "cancel.go");
    const command = 'test "$(cat retry.txt)" = retried';
    const descriptor = {
      config: factoryConfig(target.checkout, "example/lifecycle-cancel"),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("retry", { path: "retry.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot,
      actions: {
        retry: {
          barrier,
          files: [{ path: "retry.txt", text: "retried\n" }],
        },
      },
    };
    const { application, eventsPath } = makeApplication(descriptor);
    const unrelated = join(root, "unrelated-process-sentinel");
    writeFileSync(unrelated, "untouched\n");
    const running = application.runObjective(objective);
    await waitFor(
      () =>
        readEvents(eventsPath).some(
          (event) => event.type === "start" && event.item === "retry",
        ),
      fakeRoot,
      "cancellable owned attempt",
    );
    assert.equal(await application.cancelObjective(objective), "requested");
    await assert.rejects(running, /cancel/i);
    assert.equal(readFileSync(unrelated, "utf8"), "untouched\n");
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      1,
    );
    const cancelled = readState(descriptor.config.repository, objective);
    assert.equal(cancelled.work.retry.status, "cancelled");
    assert.ok(
      readDiagnostics(descriptor.config.repository, objective).some(
        (event) => event.itemId === "retry" && event.outcome === "failed",
      ),
    );
    application.retryWorkItem(objective, "retry");
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      1,
    );
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const retried = await application.runObjective(objective);
    assert.equal(retried.finalValidation.passed, true);
    assert.equal(
      readEvents(eventsPath).filter((event) => event.type === "start").length,
      2,
    );
    const retryTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(retryTimeline.some((event) => event.operation === "work-retry"));
    assert.ok(
      retryTimeline.some(
        (event) =>
          event.operation === "objective-finalization" &&
          event.outcome === "completed",
      ),
    );
  });
});

test("native application path runs a linear stack beside an independent replayed lane", async () => {
  await fixture("native-integration", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "native-roots.go");
    const commands = [
      'test "$(cat stack-a.txt)" = A',
      'test "$(cat stack-b.txt)" = B',
      'test "$(cat lane.txt)" = lane',
    ];
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-integration",
        "native-stack",
        2,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("stack-a", { path: "stack-a.txt", command: commands[0] }),
          item("stack-b", {
            path: "stack-b.txt",
            command: commands[1],
            dependencies: ["stack-a"],
          }),
          item("lane", { path: "lane.txt", command: commands[2] }),
        ],
      },
      objectiveBody: body(commands),
      fakeRoot,
      actions: {
        "stack-a": {
          barrier,
          files: [{ path: "stack-a.txt", text: "A\n" }],
        },
        "stack-b": { files: [{ path: "stack-b.txt", text: "B\n" }] },
        lane: { barrier, files: [{ path: "lane.txt", text: "lane\n" }] },
      },
    };
    const { application, eventsPath, github } = makeApplication(descriptor);
    const running = application.runObjective(objective);
    await waitFor(
      () => {
        const starts = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return starts.some((event) => event.item === "stack-a") &&
          starts.some((event) => event.item === "lane")
          ? starts
          : undefined;
      },
      fakeRoot,
      "native independent roots",
    );
    assert.ok(
      !readEvents(eventsPath).some(
        (event) => event.type === "start" && event.item === "stack-b",
      ),
    );
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const state = await running;
    assert.equal(state.finalValidation.passed, true);
    const starts = readEvents(eventsPath).filter(
      (event) => event.type === "start",
    );
    assert.equal(
      starts.find((event) => event.item === "stack-a").baseSha,
      target.baseSha,
    );
    assert.equal(
      starts.find((event) => event.item === "lane").baseSha,
      target.baseSha,
    );
    assert.equal(
      starts.find((event) => event.item === "stack-b").baseSha,
      state.work["stack-a"].changeRef,
    );
    const remote = github.state();
    const stackEvent = remote.events.find(
      (event) => event.type === "merge-stack",
    );
    assert.ok(stackEvent);
    assert.equal(state.work.lane.baseSha, stackEvent.integratedSha);
    assert.equal(state.work.lane.validation.treeSha, state.work.lane.treeSha);
    assert.equal(
      git(target.checkout, "rev-parse", `${state.work.lane.changeRef}^`),
      stackEvent.integratedSha,
    );
    const stackPulls = [
      state.work["stack-a"].pullRequest,
      state.work["stack-b"].pullRequest,
    ];
    assert.equal(remote.pullRequests[stackPulls[0]].base, "main");
    assert.equal(
      remote.pullRequests[stackPulls[1]].base,
      "factory/objective-1/stack-a",
    );
  });
});

test("native delivery admits a later dependency wave while serializing a conflicting sibling", async () => {
  await fixture("native-wave", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const barrier = join(root, "barriers", "children.go");
    const ids = ["foundation", "left", "right", "conflict", "join"];
    const commands = ids.map((id) => `test -s ${id}.txt`);
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-wave",
        "native-stack",
        3,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("foundation", { path: "foundation.txt", command: commands[0] }),
          item("left", {
            path: "left.txt",
            command: commands[1],
            dependencies: ["foundation"],
            resources: ["shared"],
          }),
          item("right", {
            path: "right.txt",
            command: commands[2],
            dependencies: ["foundation"],
          }),
          item("conflict", {
            path: "conflict.txt",
            command: commands[3],
            dependencies: ["foundation"],
            resources: ["shared"],
          }),
          item("join", {
            path: "join.txt",
            command: commands[4],
            dependencies: ["left", "right"],
          }),
        ],
      },
      objectiveBody: body(commands),
      fakeRoot,
      actions: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            ...(id === "left" || id === "right" ? { barrier } : {}),
            files: [{ path: `${id}.txt`, text: `${id}\n` }],
          },
        ]),
      ),
    };
    const { application, eventsPath } = makeApplication(descriptor);
    const running = application.runObjective(objective);
    await waitFor(
      () => {
        const starts = readEvents(eventsPath).filter(
          (event) => event.type === "start",
        );
        return (
          starts.some((event) => event.item === "left") &&
          starts.some((event) => event.item === "right")
        );
      },
      fakeRoot,
      "concurrent post-foundation children",
    );
    const beforeRelease = readEvents(eventsPath);
    assert.ok(
      beforeRelease.some(
        (event) => event.type === "complete" && event.item === "foundation",
      ),
    );
    assert.ok(
      !beforeRelease.some(
        (event) => event.type === "start" && event.item === "conflict",
      ),
    );
    assert.ok(
      !beforeRelease.some(
        (event) => event.type === "start" && event.item === "join",
      ),
    );
    mkdirSync(dirnameFor(barrier), { recursive: true });
    writeFileSync(barrier, "go\n");
    const state = await running;
    assert.equal(state.finalValidation.passed, true);
    const events = readEvents(eventsPath);
    const start = (id) =>
      events.findIndex((event) => event.type === "start" && event.item === id);
    const complete = (id) =>
      events.findIndex(
        (event) => event.type === "complete" && event.item === id,
      );
    assert.ok(start("left") > complete("foundation"));
    assert.ok(start("right") > complete("foundation"));
    assert.ok(start("conflict") > complete("left"));
    assert.ok(start("join") > complete("left"));
    assert.ok(start("join") > complete("right"));
    assert.equal(state.work.right.validation.treeSha, state.work.right.treeSha);
  });
});

test("native execution failure is terminal until an explicit safe retry", async () => {
  await fixture("native-retry", async (root) => {
    const target = createTarget(root);
    const fakeRoot = join(root, "fake");
    const command = "test -s retry.txt";
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-retry",
        "native-stack",
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("retry", { path: "retry.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot,
      actions: {
        retry: {
          failAttempts: 1,
          files: [{ path: "retry.txt", text: "retried\n" }],
        },
      },
    };
    const { application, eventsPath } = makeApplication(descriptor);
    await assert.rejects(
      application.runObjective(objective),
      /Scripted failure for retry/,
    );
    const failed = readState(descriptor.config.repository, objective);
    assert.equal(failed.work.retry.status, "failed");
    assert.match(failed.work.retry.error, /Scripted failure for retry/);
    assert.equal(failed.work.retry.pullRequest, undefined);
    const failureTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(
      failureTimeline.some(
        (event) =>
          event.itemId === "retry" &&
          event.attemptId === failed.work.retry.attempt &&
          event.outcome === "failed" &&
          /Scripted failure/.test(event.detail),
      ),
    );
    await assert.rejects(application.runObjective(objective), /explicit retry/);
    application.retryWorkItem(objective, "retry");
    const done = await application.runObjective(objective);
    assert.equal(done.finalValidation.passed, true);
    assert.equal(
      readEvents(eventsPath).filter(
        (event) => event.type === "start" && event.item === "retry",
      ).length,
      2,
    );
    const retryTimeline = readDiagnostics(
      descriptor.config.repository,
      objective,
    );
    assert.ok(retryTimeline.some((event) => event.operation === "work-retry"));
    assert.ok(
      retryTimeline.some(
        (event) =>
          event.itemId === "retry" &&
          event.attemptId === done.work.retry.attempt &&
          event.outcome === "completed",
      ),
    );
  });
});

test("native retry stops when its stack already has a published layer", async () => {
  await fixture("native-published-retry", async (root) => {
    const target = createTarget(root);
    const commands = ["test -s first.txt", "test -s second.txt"];
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/native-published-retry",
        "native-stack",
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("first", { path: "first.txt", command: commands[0] }),
          item("second", {
            path: "second.txt",
            command: commands[1],
            dependencies: ["first"],
          }),
        ],
      },
      objectiveBody: body(commands),
      fakeRoot: join(root, "fake"),
      actions: {
        first: { files: [{ path: "first.txt", text: "first\n" }] },
        second: {
          failAttempts: 1,
          files: [{ path: "second.txt", text: "second\n" }],
        },
      },
    };
    const { application, eventsPath } = makeApplication(descriptor);
    await assert.rejects(
      application.runObjective(objective),
      /Scripted failure for second/,
    );
    const state = readState(descriptor.config.repository, objective);
    assert.ok(state.work.first.pullRequest);
    assert.equal(state.work.second.status, "failed");
    assert.throws(
      () => application.retryWorkItem(objective, "second"),
      /Published PR requires operator direction/,
    );
    assert.equal(
      readEvents(eventsPath).filter(
        (event) => event.type === "start" && event.item === "second",
      ).length,
      1,
    );
  });
});

test("asset selection preserves a complete multi-file set and hydrates target-owned LFS bytes", async () => {
  await fixture("asset-integration", async (root) => {
    const selectedModel = Buffer.concat([
      Buffer.from("selected model bytes", "utf8"),
      Buffer.from([0, 1, 2]),
    ]);
    const target = createTarget(root, {
      ".gitattributes": "approved/*.bin filter=lfs diff=lfs merge=lfs -text\n",
      "inputs/source.bin": "source fixture bytes\n",
    });
    git(target.checkout, "lfs", "install", "--local");
    const fakeRoot = join(root, "fake");
    const command =
      'test -s approved/model.bin && test "$(cat approved/metadata.json)" = \'{"candidate":"b"}\'';
    const consumerCommand = "test -s approved/consumed.txt";
    const media = item("media", {
      path: "approved/model.bin",
      command,
      ownedPaths: ["approved/model.bin", "approved/metadata.json"],
      sourceAssets: [
        {
          path: "inputs/source.bin",
          role: "source",
          mediaType: "application/octet-stream",
          visibility: "repository",
        },
      ],
      expectedOutputRoles: ["model", "metadata"],
      minimumAssetSets: 2,
      requiredLfsRoles: ["model"],
    });
    const provenance = {
      source: "inputs/source.bin",
      rights: "public integration fixture",
      visibility: "repository",
      lineage: ["inputs/source.bin"],
    };
    const consumer = item("consumer", {
      path: "approved/consumed.txt",
      command: consumerCommand,
      dependencies: ["media"],
    });
    const descriptor = {
      config: factoryConfig(target.checkout, "example/asset-integration"),
      graph: { objective, baseSha: target.baseSha, items: [media, consumer] },
      objectiveBody: body([command, consumerCommand]),
      fakeRoot,
      actions: {
        media: {
          assets: [
            {
              id: "candidate-a",
              members: [
                {
                  role: "model",
                  file: "model.bin",
                  mediaType: "application/octet-stream",
                  destination: "approved/model.bin",
                  text: "other model bytes",
                },
                {
                  role: "metadata",
                  file: "metadata.json",
                  mediaType: "application/json",
                  destination: "approved/metadata.json",
                  text: '{"candidate":"a"}\n',
                },
              ],
              provenance,
            },
            {
              id: "candidate-b",
              members: [
                {
                  role: "model",
                  file: "model.bin",
                  mediaType: "application/octet-stream",
                  destination: "approved/model.bin",
                  base64: selectedModel.toString("base64"),
                },
                {
                  role: "metadata",
                  file: "metadata.json",
                  mediaType: "application/json",
                  destination: "approved/metadata.json",
                  text: '{"candidate":"b"}\n',
                },
              ],
              relationships: [
                {
                  from: "inputs/source.bin",
                  toRole: "model",
                  kind: "derived-from",
                },
              ],
              provenance,
            },
          ],
        },
        consumer: {
          consumeSelected: {
            roles: ["model", "metadata"],
            output: "approved/consumed.txt",
          },
        },
      },
    };
    const { application } = makeApplication(descriptor);
    const waiting = await application.runObjective(objective);
    assert.equal(waiting.work.media.status, "waiting");
    assert.equal(waiting.work.media.assets.length, 2);
    assert.equal(waiting.work.media.assets[1].members.length, 2);
    const review = join(root, "review");
    await application.exportAssetSetForReview(
      objective,
      "media",
      "candidate-b",
      review,
    );
    assert.deepEqual(
      readFileSync(join(review, "model-model.bin")),
      selectedModel,
    );
    assert.equal(
      readFileSync(join(review, "metadata-metadata.json"), "utf8"),
      '{"candidate":"b"}\n',
    );
    await application.selectAssetSet(objective, "media", "candidate-b", {
      actor: "test-operator",
      reason: "reviewed opaque pair",
      downstreamItems: ["consumer"],
    });
    const completed = await application.runObjective(objective);
    assert.equal(completed.finalValidation.passed, true);
    assert.equal(completed.work.media.selectedAssetSet, "candidate-b");
    assert.equal(completed.work.media.selection.actor, "test-operator");
    assert.deepEqual(completed.work.media.selection.downstreamItems, [
      "consumer",
    ]);
    assert.deepEqual(
      completed.work.media.selection.destinations.map((entry) => entry.role),
      ["model", "metadata"],
    );
    git(target.checkout, "fetch", "origin", "main");
    const pointer = git(
      target.checkout,
      "show",
      `${completed.integratedSha}:approved/model.bin`,
    );
    assert.match(pointer, /oid sha256:/);
    const clone = join(root, "hydrated");
    execFileSync("git", ["clone", "--no-checkout", target.origin, clone], {
      stdio: "ignore",
    });
    git(clone, "lfs", "install", "--local");
    git(clone, "checkout", "--detach", completed.integratedSha);
    git(clone, "lfs", "pull");
    assert.deepEqual(
      readFileSync(join(clone, "approved/model.bin")),
      selectedModel,
    );
    assert.equal(
      readFileSync(join(clone, "approved/metadata.json"), "utf8"),
      '{"candidate":"b"}\n',
    );
    assert.equal(
      readFileSync(join(clone, "approved/consumed.txt"), "utf8"),
      `model:${selectedModel.toString("hex")}\nmetadata:${Buffer.from('{"candidate":"b"}\n').toString("hex")}\n`,
    );
  });
});

function dirnameFor(path) {
  return path.slice(0, path.lastIndexOf("/"));
}

test("partial projection reuses issues and dependency relationships", async () => {
  await fixture("projection-replay", async (root) => {
    const target = createTarget(root);
    const command = "test -s first.txt && test -s second.txt";
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/projection-replay",
        "regular",
        1,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [
          item("first", { path: "first.txt" }),
          item("second", { path: "second.txt", dependencies: ["first"] }),
        ],
      },
      objectiveBody: body([command, "test -s first.txt", "test -s second.txt"]),
      fakeRoot: join(root, "fake"),
      actions: {
        first: { files: [{ path: "first.txt", text: "first\n" }] },
        second: { files: [{ path: "second.txt", text: "second\n" }] },
      },
    };
    const { application, github } = makeApplication(descriptor);
    github.failProjectionAfter = 1;
    await assert.rejects(
      application.runObjective(objective),
      /partial projection/,
    );
    const firstIssue = github.state().issues.first;
    assert.equal(github.state().issues.second, undefined);
    const completed = await application.runObjective(objective);
    assert.equal(completed.finalValidation.passed, true);
    assert.equal(github.state().issues.first, firstIssue);
    assert.equal(Object.keys(github.state().issues).length, 2);
    assert.deepEqual(github.state().dependencies.second, ["first"]);
    assert.equal(github.state().closedIssues[firstIssue], true);
  });
});

test("close failures replay after merge and final validation without worker or PR replay", async () => {
  await fixture("closure-replay", async (root) => {
    const target = createTarget(root);
    const command = "test -s result.txt";
    const descriptor = {
      config: factoryConfig(
        target.checkout,
        "example/closure-replay",
        "regular",
        1,
      ),
      graph: {
        objective,
        baseSha: target.baseSha,
        items: [item("result", { path: "result.txt", command })],
      },
      objectiveBody: body([command]),
      fakeRoot: join(root, "fake"),
      actions: {
        result: { files: [{ path: "result.txt", text: "complete\n" }] },
      },
    };
    const { application, github, eventsPath } = makeApplication(descriptor);
    github.failCloseAfterComment = 100;
    await assert.rejects(application.runObjective(objective), /close failure/);
    const afterMerge = readState(descriptor.config.repository, objective);
    assert.equal(afterMerge.work.result.status, "done");
    assert.equal(afterMerge.work.result.githubClosure, "pending");
    assert.equal(afterMerge.error, undefined);
    assert.match(afterMerge.githubClosureError, /close failure/);
    const mergedPr = afterMerge.work.result.pullRequest;
    const expectedHead = github.state().pullRequests[mergedPr].headSha;
    github.update((state) => {
      state.pullRequests[mergedPr].headSha = target.baseSha;
    });
    await assert.rejects(
      application.runObjective(objective),
      /identity changed/,
    );
    github.update((state) => {
      state.pullRequests[mergedPr].headSha = expectedHead;
    });
    const counts = () => ({
      starts: readEvents(eventsPath).filter((event) => event.type === "start")
        .length,
      publishes: github
        .state()
        .events.filter((event) => event.type === "publish").length,
      merges: github.state().events.filter((event) => event.type === "merge")
        .length,
    });
    const beforeReplay = counts();
    github.failCloseAfterComment = objective;
    await assert.rejects(application.runObjective(objective), /close failure/);
    const afterValidation = readState(descriptor.config.repository, objective);
    assert.equal(afterValidation.finalValidation.passed, true);
    assert.equal(afterValidation.work.result.githubClosure, "complete");
    assert.equal(afterValidation.objectiveClosure, "pending");
    const completed = await application.runObjective(objective);
    assert.equal(completed.objectiveClosure, "complete");
    assert.deepEqual(counts(), beforeReplay);
    assert.equal(github.state().issueComments[100].length, 1);
    assert.equal(github.state().issueComments[objective].length, 1);
  });
});
