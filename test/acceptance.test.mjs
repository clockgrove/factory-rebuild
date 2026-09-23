import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compilePlan,
  objectiveCriteria,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import {
  AcceptanceDecisionRequired,
  assertPinnedNpmScripts,
  PINNED_PNPM_BOOTSTRAP,
  reviewAcceptance,
  validateTree,
  validateWorkItem,
} from "../dist/validation.js";
import { decideResult } from "../dist/runner.js";
import { readState, saveState, statePath } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  git,
} from "./support/integration-fixture.mjs";

function item(baseSha, validation) {
  return {
    objective: 1,
    baseSha,
    items: [
      {
        id: "one",
        title: "One",
        goal: "Create result",
        acceptance: ["result.txt exists"],
        nonGoals: ["No deployment"],
        citations: [{ path: "OBJECTIVE" }],
        dependencies: [],
        ownedPaths: ["result.txt"],
        resources: [],
        validation,
        brief: "Create result",
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      },
    ],
  };
}

async function withTarget(name, files, run) {
  const root = mkdtempSync(join(tmpdir(), `factory-accept-${name}-`));
  try {
    const target = createTarget(root, files);
    return await run(root, target);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("preview blocks invented and mismatched commands, and admits exact pinned base scripts", async () => {
  await withTarget(
    "commands",
    {
      "package.json": JSON.stringify({
        scripts: { test: "test -s result.txt", check: "test -s result.txt" },
      }),
    },
    async (_root, target) => {
      const body =
        "# Objective\n\n## Acceptance\n- result.txt exists\n- `test -s result.txt`\n\n## Final validation\n- `npm test`\n";
      let graph = item(target.baseSha, [
        {
          command: "test -s result.txt",
          provenance: "source-declared",
          source: "OBJECTIVE",
        },
      ]);
      const model = {
        async generateStructured() {
          return structuredClone(graph);
        },
        async reviewGraph() {
          return { findings: [] };
        },
      };
      const accepted = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(accepted.commands[0].hostExecution, "authorized");
      assert.equal(accepted.commands[1].itemId, "OBJECTIVE");
      verifyPlanCandidate(accepted, 1, body, target.baseSha, target.checkout);

      graph = item(target.baseSha, [
        {
          command: "npm test",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const base = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(base.commands[0].hostExecution, "authorized");
      verifyPlanCandidate(base, 1, body, target.baseSha, target.checkout);

      graph = item(target.baseSha, [
        {
          command: "pnpm check",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const pnpm = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(pnpm.commands[0].hostExecution, "authorized");
      verifyPlanCandidate(pnpm, 1, body, target.baseSha, target.checkout);

      graph = item(target.baseSha, [
        {
          command: "npm run invented",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const invented = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(invented.commands[0].hostExecution, "blocked");
      assert.throws(
        () =>
          verifyPlanCandidate(
            invented,
            1,
            body,
            target.baseSha,
            target.checkout,
          ),
        /host execution authority/,
      );

      graph = item(target.baseSha, [
        {
          command: "test -s result.txt; echo surprise",
          provenance: "source-declared",
          source: "OBJECTIVE",
        },
      ]);
      const substring = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(substring.commands[0].hostExecution, "blocked");
    },
  );
});

test("Objective criteria use explicit acceptance or the source Goal", () => {
  assert.deepEqual(objectiveCriteria("## Acceptance\n- one\n- two\n"), [
    "one",
    "two",
  ]);
  assert.deepEqual(
    objectiveCriteria(
      "## Goal\n\nDeliver a complete result.\n\n## Final validation\n- `true`\n",
    ),
    ["Deliver a complete result."],
  );
  assert.deepEqual(
    objectiveCriteria(
      "### Outcome\n\nDeliver a result.\n\n### Acceptance\n\n- First observable check\n- Second observable check\n\n### Boundaries\nNo deployment\n",
    ),
    ["First observable check", "Second observable check"],
  );
  assert.deepEqual(
    objectiveCriteria(
      "### Outcome\n\nDeliver a result.\n\n### What must be true\n\nA user sees the result.\n\n### Boundaries\nNo deployment\n",
    ),
    ["A user sees the result."],
  );
});

test("changed npm and pnpm lifecycle hooks stop validation before any result shell runs", async () => {
  for (const [command, name] of [
    ["npm test", "test"],
    ["pnpm check", "check"],
  ]) {
    await withTarget(
      `${name}-scripts`,
      { "package.json": JSON.stringify({ scripts: { [name]: "true" } }) },
      async (root, target) => {
        const marker = join(root, "unexpected-script-execution");
        writeFileSync(
          join(target.checkout, "package.json"),
          JSON.stringify({
            scripts: { [name]: "true", [`pre${name}`]: `touch ${marker}` },
          }),
        );
        git(target.checkout, "add", "package.json");
        git(
          target.checkout,
          "-c",
          "user.name=Factory Test",
          "-c",
          "user.email=factory-test@example.com",
          "commit",
          "-m",
          "Add lifecycle hook",
        );
        const commit = git(target.checkout, "rev-parse", "HEAD");
        const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
        assert.throws(
          () =>
            validateWorkItem(
              target.checkout,
              join(root, "validation"),
              item(target.baseSha, [
                {
                  command,
                  provenance: "base-observed",
                  source: "package.json",
                },
              ]).items[0],
              commit,
              treeSha,
              target.baseSha,
            ),
          /lifecycle hook pre(?:test|check) differs from the accepted base/,
        );
        assert.equal(existsSync(marker), false);
      },
    );
  }
});

test("benign package metadata and dependency edits retain selected npm and pnpm scripts", async () => {
  await withTarget(
    "package-metadata",
    {
      "package.json": JSON.stringify({
        scripts: { test: "true", check: "true", lint: "true" },
        description: "before",
      }),
    },
    async (root, target) => {
      writeFileSync(
        join(target.checkout, "package.json"),
        JSON.stringify({
          scripts: { test: "true", check: "true", lint: "echo changed" },
          description: "after",
          dependencies: { example: "1.0.0" },
        }),
      );
      git(target.checkout, "add", "package.json");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Edit metadata",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
      assert.doesNotThrow(() =>
        assertPinnedNpmScripts(target.checkout, target.baseSha, commit, [
          "npm test",
          "pnpm check",
        ]),
      );
      const evidence = validateWorkItem(
        target.checkout,
        join(root, "validation"),
        item(target.baseSha, [
          {
            command: "npm test",
            provenance: "base-observed",
            source: "package.json",
          },
        ]).items[0],
        commit,
        treeSha,
        target.baseSha,
      );
      assert.equal(evidence.commands[0].passed, true);
    },
  );
});

test("nested pnpm script wrappers require separate authority", async () => {
  await withTarget(
    "nested-pnpm",
    {
      "package.json": JSON.stringify({
        scripts: { check: "pnpm run lint", lint: "true" },
      }),
    },
    async (_root, target) => {
      writeFileSync(
        join(target.checkout, "package.json"),
        JSON.stringify({
          scripts: { check: "pnpm run lint", lint: "touch unexpected" },
        }),
      );
      git(target.checkout, "add", "package.json");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Change nested script",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      assert.throws(
        () =>
          assertPinnedNpmScripts(target.checkout, target.baseSha, commit, [
            "pnpm check",
          ]),
        /nested package-manager invocation in check needs separate authority/,
      );
    },
  );
});

test("exact script-disabled pnpm bootstrap is source-authorized and plain install is blocked", async () => {
  await withTarget(
    "pnpm-bootstrap",
    {
      "package.json": JSON.stringify({ scripts: { check: "true" } }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    },
    async (_root, target) => {
      const body = `# Objective\n\n## Acceptance\n- Check passes\n\n## Final validation\n- \`${PINNED_PNPM_BOOTSTRAP}\`\n- \`pnpm check\`\n`;
      const graph = item(target.baseSha, [
        {
          command: "pnpm check",
          provenance: "base-observed",
          source: "package.json",
        },
      ]);
      const model = {
        async generateStructured() {
          return structuredClone(graph);
        },
        async reviewGraph() {
          return { findings: [] };
        },
      };
      const plan = await compilePlan(
        1,
        body,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.ok(
        plan.commands.every((entry) => entry.hostExecution === "authorized"),
      );
      verifyPlanCandidate(plan, 1, body, target.baseSha, target.checkout);
      assert.doesNotThrow(() =>
        assertPinnedNpmScripts(
          target.checkout,
          target.baseSha,
          target.baseSha,
          [PINNED_PNPM_BOOTSTRAP, "pnpm check"],
        ),
      );

      const unsafeBody = body.replace(PINNED_PNPM_BOOTSTRAP, "pnpm install");
      const unsafe = await compilePlan(
        1,
        unsafeBody,
        target.baseSha,
        target.checkout,
        model,
      );
      assert.equal(
        unsafe.commands.find((entry) => entry.command === "pnpm install")
          ?.hostExecution,
        "blocked",
      );
      assert.throws(
        () =>
          verifyPlanCandidate(
            unsafe,
            1,
            unsafeBody,
            target.baseSha,
            target.checkout,
          ),
        /host execution authority/,
      );
      writeFileSync(
        join(target.checkout, ".pnpmfile.cjs"),
        "module.exports = {}\n",
      );
      git(target.checkout, "add", ".pnpmfile.cjs");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Add pnpm hook",
      );
      const withHook = git(target.checkout, "rev-parse", "HEAD");
      assert.throws(
        () =>
          assertPinnedNpmScripts(target.checkout, target.baseSha, withHook, [
            PINNED_PNPM_BOOTSTRAP,
            "pnpm check",
          ]),
        /pnpmfile hooks need separate authority/,
      );
    },
  );
});

test("result review auto-accepts sourced evidence, otherwise asks one exact-tree decision", async () => {
  await withTarget("review", {}, async (root, target) => {
    writeFileSync(join(target.checkout, "result.txt"), "created\n");
    git(target.checkout, "add", "result.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Create result",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const evidence = validateTree(
      target.checkout,
      join(root, "validation"),
      commit,
      treeSha,
      [],
    );
    const sources = [
      { path: "OBJECTIVE", content: "## Acceptance\n- result.txt exists\n" },
    ];
    const request = {
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit,
      evidence,
      criteria: ["result.txt exists"],
      sources,
    };
    await assert.rejects(
      reviewAcceptance({ ...request, model: {} }),
      AcceptanceDecisionRequired,
    );
    const clean = await reviewAcceptance({
      ...request,
      model: {
        async reviewResult() {
          return {
            findings: [
              {
                criterion: "result.txt exists",
                verdict: "pass",
                source: "OBJECTIVE",
                quote: "result.txt exists",
                detail: "The diff adds result.txt",
                question: "",
              },
            ],
          };
        },
      },
    });
    assert.equal(clean.criteria[0].verdict, "pass");
    assert.equal(clean.treeSha, treeSha);
    const unsure = {
      async reviewResult() {
        return {
          findings: [
            {
              criterion: "result.txt exists",
              verdict: "needs-human",
              source: "OBJECTIVE",
              quote: "result.txt exists",
              detail: "Content semantics unclear",
              question: "Does this file meet the target need?",
            },
          ],
        };
      },
    };
    await assert.rejects(
      reviewAcceptance({ ...request, model: unsure }),
      (error) => {
        assert.ok(error instanceof AcceptanceDecisionRequired);
        assert.equal(error.pending.treeSha, treeSha);
        assert.equal(error.pending.criterion, "result.txt exists");
        return true;
      },
    );
    const decision = {
      criterion: "result.txt exists",
      treeSha,
      actor: "owner",
      at: new Date().toISOString(),
      outcome: "accept",
      reason: "Inspected this exact result",
    };
    const approved = await reviewAcceptance({
      ...request,
      model: unsure,
      decisions: [decision],
    });
    assert.equal(approved.criteria[0].verdict, "human-accept");
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: unsure,
        decisions: [{ ...decision, treeSha: target.baseSha }],
      }),
      AcceptanceDecisionRequired,
    );
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: unsure,
        decisions: [{ ...decision, outcome: "refuse" }],
      }),
      /refused/,
    );
  });
});

test("large binary results reach independent review as descriptors, and reviewer failure is explicit", async () => {
  await withTarget("binary-review", {}, async (root, target) => {
    writeFileSync(join(target.checkout, "image.bin"), Buffer.alloc(150_000));
    git(target.checkout, "add", "image.bin");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Add binary result",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const request = {
      checkout: target.checkout,
      baseSha: target.baseSha,
      commit,
      evidence: validateTree(
        target.checkout,
        join(root, "validation"),
        commit,
        treeSha,
        [],
      ),
      criteria: ["image exists"],
      sources: [{ path: "OBJECTIVE", content: "image exists" }],
    };
    let calls = 0;
    await assert.rejects(
      reviewAcceptance({
        ...request,
        model: {
          async reviewResult(review) {
            calls++;
            const packet = JSON.parse(review.change);
            assert.equal(packet.changes[0].path, "image.bin");
            assert.equal(packet.changes[0].newBytes, 150_000);
            assert.match(packet.changes[0].newObject, /^[0-9a-f]{40}$/);
            assert.match(packet.patches[0].excerpt, /Binary files/);
            assert.equal(packet.patches[0].truncated, false);
            assert.ok(review.change.length < 10_000);
            throw new Error("review context unavailable");
          },
        },
      }),
      (error) => {
        assert.ok(error instanceof AcceptanceDecisionRequired);
        assert.match(error.pending.detail, /review context unavailable/);
        assert.equal(error.pending.treeSha, treeSha);
        return true;
      },
    );
    assert.equal(calls, 1);
  });
});

test("a reviewer pass cannot auto-accept truncated result text", async () => {
  await withTarget("large-text-review", {}, async (root, target) => {
    writeFileSync(
      join(target.checkout, "result.txt"),
      "line of content\n".repeat(20_000),
    );
    git(target.checkout, "add", "result.txt");
    git(
      target.checkout,
      "-c",
      "user.name=Factory Test",
      "-c",
      "user.email=factory-test@example.com",
      "commit",
      "-m",
      "Add large text result",
    );
    const commit = git(target.checkout, "rev-parse", "HEAD");
    const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
    const previous = process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
    process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = "2048";
    let calls = 0;
    try {
      await assert.rejects(
        reviewAcceptance({
          checkout: target.checkout,
          baseSha: target.baseSha,
          commit,
          evidence: validateTree(
            target.checkout,
            join(root, "validation"),
            commit,
            treeSha,
            [],
          ),
          criteria: ["result meets requirements"],
          sources: [
            { path: "OBJECTIVE", content: "result meets requirements" },
          ],
          model: {
            async reviewResult(review) {
              calls++;
              const packet = JSON.parse(review.change);
              assert.equal(packet.textBudget, 2048);
              assert.equal(packet.changes[0].path, "result.txt");
              assert.match(packet.changes[0].newObject, /^[0-9a-f]{40}$/);
              assert.match(packet.patches[0].lineStats, /^20000\s+0\s+/);
              assert.equal(packet.patches[0].truncated, true);
              assert.ok(
                Buffer.byteLength(packet.patches[0].excerpt, "utf8") <= 2048,
              );
              assert.ok(review.change.length < 4000);
              return {
                findings: [
                  {
                    criterion: "result meets requirements",
                    verdict: "pass",
                    source: "OBJECTIVE",
                    quote: "result meets requirements",
                    detail:
                      "Objective quote says the result meets requirements",
                    question: "",
                  },
                ],
              };
            },
          },
        }),
        (error) => {
          assert.ok(error instanceof AcceptanceDecisionRequired);
          assert.equal(error.pending.treeSha, treeSha);
          assert.match(error.pending.detail, /text excerpts were truncated/);
          assert.match(error.pending.detail, /result.txt/);
          assert.match(
            error.pending.question,
            /FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES/,
          );
          return true;
        },
      );
      assert.equal(calls, 1);
      const accepted = await reviewAcceptance({
        checkout: target.checkout,
        baseSha: target.baseSha,
        commit,
        evidence: validateTree(
          target.checkout,
          join(root, "validation-again"),
          commit,
          treeSha,
          [],
        ),
        criteria: ["result meets requirements"],
        sources: [{ path: "OBJECTIVE", content: "result meets requirements" }],
        model: {},
        decisions: [
          {
            criterion: "result meets requirements",
            treeSha,
            actor: "owner",
            at: new Date().toISOString(),
            outcome: "accept",
            reason: "Inspected the full exact tree",
          },
        ],
      });
      assert.equal(accepted.criteria[0].verdict, "human-accept");
    } finally {
      if (previous === undefined)
        delete process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES;
      else process.env.FACTORY_RESULT_REVIEW_TEXT_BUDGET_BYTES = previous;
    }
  });
});

test("operator decision records criterion and exact tree before resuming validation", async () => {
  await withTarget("decision", {}, async (root, target) => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = join(root, "state");
    try {
      writeFileSync(join(target.checkout, "result.txt"), "created\n");
      git(target.checkout, "add", "result.txt");
      git(
        target.checkout,
        "-c",
        "user.name=Factory Test",
        "-c",
        "user.email=factory-test@example.com",
        "commit",
        "-m",
        "Create result",
      );
      const commit = git(target.checkout, "rev-parse", "HEAD");
      const treeSha = git(target.checkout, "rev-parse", "HEAD^{tree}");
      const config = factoryConfig(target.checkout, "example/acceptance");
      const state = {
        schemaVersion: 1,
        repository: config.repository,
        objective: 1,
        runId: "acceptance-test",
        configDigest: "a".repeat(64),
        baseSha: target.baseSha,
        graph: item(target.baseSha, []),
        objectiveCommands: [],
        issueByItemId: { one: 2 },
        work: {
          one: {
            status: "waiting",
            step: "approve-result",
            baseSha: target.baseSha,
            changeRef: commit,
            treeSha,
            acceptancePending: {
              criterion: "result.txt exists",
              treeSha,
              source: "OBJECTIVE",
              quote: "result.txt exists",
              question: "Does the result satisfy this criterion?",
              detail: "Review needs owner evidence",
            },
          },
        },
      };
      saveState(statePath(config.repository, 1), state);
      assert.throws(
        () =>
          decideResult(config, 1, {
            item: "one",
            treeSha: target.baseSha,
            actor: "owner",
            outcome: "accept",
            reason: "Reviewed",
          }),
        /tree differs/,
      );
      assert.equal(readState(config.repository, 1).work.one.status, "waiting");
      decideResult(config, 1, {
        item: "one",
        treeSha,
        actor: "owner",
        outcome: "accept",
        reason: "Reviewed the exact result",
      });
      const resumed = readState(config.repository, 1).work.one;
      assert.equal(resumed.status, "running");
      assert.equal(resumed.step, "validate");
      assert.equal(
        resumed.acceptanceDecisions[0].criterion,
        "result.txt exists",
      );
      assert.equal(resumed.acceptanceDecisions[0].treeSha, treeSha);
      assert.ok(resumed.acceptanceDecisions[0].at);
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });
});
