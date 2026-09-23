import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  compilePlan,
  resolvePlan,
  verifyPlanCandidate,
} from "../dist/compiler.js";
import { composePlanning } from "../dist/application.js";
import { stateRoot } from "../dist/config.js";
import { readDiagnostics } from "../dist/diagnostics.js";
import { statePath } from "../dist/state-store.js";
import {
  createTarget,
  factoryConfig,
  makeApplication,
} from "./support/integration-fixture.mjs";

function graph(
  baseSha,
  citation = { path: "OBJECTIVE", heading: "Acceptance" },
) {
  return {
    objective: 1,
    baseSha,
    items: [
      {
        id: "one",
        title: "One",
        goal: "Write one.txt",
        acceptance: ["one.txt exists"],
        nonGoals: ["No deployment"],
        citations: [citation],
        dependencies: [],
        ownedPaths: ["one.txt"],
        resources: [],
        validation: [
          {
            command: "test -s one.txt",
            provenance: "source-declared",
            source: "OBJECTIVE",
          },
        ],
        brief: "Write one.txt",
        sourceAssets: [],
        expectedOutputRoles: [],
        minimumAssetSets: 0,
        requiredLfsRoles: [],
      },
    ],
  };
}

const body = `# Objective

## Acceptance
- \`test -s one.txt\`

## Planning sources
- \`docs/plan.md#Wave 0\`
`;

async function fixture(name, callback) {
  const root = mkdtempSync(join(tmpdir(), `factory-plan-${name}-`));
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

test("read-only plan uses pinned selected heading despite dirty checkout", async () => {
  await fixture("pinned", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md":
        "# Plan\n\n## Wave 0\nCanonical obligation\n\n## Wave 1\nUnselected text\n",
    });
    const descriptor = {
      config: factoryConfig(target.checkout, "example/pinned-plan"),
      graph: graph(target.baseSha, { path: "docs/plan.md", heading: "Wave 0" }),
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
    };
    assert.equal(existsSync(stateRoot(descriptor.config.repository)), false);
    composePlanning(descriptor.config);
    assert.equal(existsSync(stateRoot(descriptor.config.repository)), false);
    const { application, github } = makeApplication(descriptor);
    writeFileSync(
      join(target.checkout, "docs/plan.md"),
      "# Plan\n\n## Wave 0\nDirty replacement\n",
    );
    const candidate = await application.planObjective(1);
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.commands[0].hostExecution, "authorized");
    assert.equal(candidate.graphDigest.length, 64);
    assert.match(
      candidate.sources.find((source) => source.path === "docs/plan.md")
        .content,
      /Canonical obligation/,
    );
    assert.doesNotMatch(
      candidate.sources.find((source) => source.path === "docs/plan.md")
        .content,
      /Unselected text|Dirty replacement/,
    );
    assert.equal(existsSync(statePath(descriptor.config.repository, 1)), false);
    assert.equal(Object.keys(github.state().issues).length, 0);
    verifyPlanCandidate(candidate, 1, body, target.baseSha, target.checkout);
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body.replace("# Objective", "# Changed Objective"),
          target.baseSha,
          target.checkout,
        ),
      /differs from the current Objective/,
    );
  });
});

test("preview shows an undeclared command as blocked before host execution", async () => {
  await fixture("command", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const invented = graph(target.baseSha);
    invented.items[0].validation[0].command = "test -s one";
    const model = {
      async generateStructured() {
        return invented;
      },
      async reviewGraph() {
        return { findings: [] };
      },
    };
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(candidate.commands[0].hostExecution, "blocked");
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /without established host execution authority/,
    );
  });
});

test("planning rejects missing selected heading without mutating run state", async () => {
  await fixture("missing", async (root) => {
    const target = createTarget(root, { "docs/plan.md": "# Plan\n" });
    const model = {
      async generateStructured() {
        throw new Error("model should not run");
      },
      async reviewGraph() {
        throw new Error("review should not run");
      },
    };
    await assert.rejects(
      compilePlan(1, body, target.baseSha, target.checkout, model),
      /0 headings named Wave 0/,
    );
    const descriptor = {
      config: factoryConfig(target.checkout, "example/missing-plan"),
      graph: graph(target.baseSha),
      objectiveBody: body,
      fakeRoot: join(root, "fake"),
      actions: {},
    };
    const { application } = makeApplication(descriptor);
    await assert.rejects(
      application.runObjective(1),
      /0 headings named Wave 0/,
    );
    assert.ok(
      readDiagnostics(descriptor.config.repository, 1).some(
        (event) =>
          event.operation === "planning" &&
          event.outcome === "failed" &&
          event.durationMs >= 0 &&
          /0 headings named Wave 0/.test(event.detail),
      ),
    );
    assert.equal(existsSync(statePath("example/missing-plan", 1)), false);
  });
});

test("one sourced review finding permits one revision and re-review", async () => {
  await fixture("review", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    const calls = [];
    const model = {
      async generateStructured(request) {
        calls.push({ type: "compile", objective: request.objective });
        return graph(target.baseSha);
      },
      async reviewGraph() {
        calls.push({ type: "review" });
        return {
          findings:
            calls.filter((call) => call.type === "review").length === 1
              ? [
                  {
                    source: "OBJECTIVE",
                    quote: "## Acceptance",
                    detail: "Missing obligation",
                    question: "Which requirement owns this obligation?",
                  },
                ]
              : [],
        };
      },
    };
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.review.revisions, 1);
    assert.deepEqual(
      calls.map((call) => call.type),
      ["compile", "review", "compile", "review"],
    );
    assert.match(calls[2].objective, /Missing obligation/);
  });
});

test("unresolved review asks one human question and records a specific decision", async () => {
  await fixture("decision", async (root) => {
    const target = createTarget(root, {
      "docs/plan.md": "# Plan\n\n## Wave 0\nCanonical obligation\n",
    });
    let reviewCount = 0;
    const model = {
      async generateStructured() {
        return graph(target.baseSha);
      },
      async reviewGraph(request) {
        reviewCount += 1;
        return {
          findings: request.sources.some(
            (source) => source.path === "OPERATOR_DECISION",
          )
            ? []
            : [
                {
                  source: "OBJECTIVE",
                  quote: "## Acceptance",
                  detail: "Authority unresolved",
                  question: "Which source authorizes this?",
                },
              ],
        };
      },
    };
    const candidate = await compilePlan(
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
    );
    assert.equal(candidate.review.status, "needs-human");
    assert.equal(reviewCount, 2);
    assert.throws(
      () =>
        verifyPlanCandidate(
          candidate,
          1,
          body,
          target.baseSha,
          target.checkout,
        ),
      /specific human source decision/,
    );
    const decided = await resolvePlan(
      candidate,
      1,
      body,
      target.baseSha,
      target.checkout,
      model,
      {
        actor: "test operator",
        outcome: "accept",
        answer: "Use the Objective Acceptance section",
        reason: "The target owner confirmed this source",
      },
    );
    assert.equal(decided.review.status, "clean");
    assert.equal(
      decided.humanDecision.question,
      "Which source authorizes this?",
    );
    assert.ok(decided.humanDecision.at);
    verifyPlanCandidate(decided, 1, body, target.baseSha, target.checkout);
  });
});
