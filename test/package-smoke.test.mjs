import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createTarget } from "./support/integration-fixture.mjs";

test("fresh packed artifact installs and exposes documented install/status/plan operations", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-package-smoke-"));
  try {
    const target = createTarget(root);
    const pack = join(root, "pack");
    const prefix = join(root, "prefix");
    const config = join(root, "config", "factory.json");
    mkdirSync(pack, { recursive: true });
    const project = resolve(import.meta.dirname, "..");
    const packageName = execFileSync(
      "npm",
      ["pack", "--silent", "--pack-destination", pack],
      { cwd: project, encoding: "utf8" },
    ).trim();
    const emptyCache = join(root, "empty-npm-cache");
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--prefix",
        prefix,
        "--ignore-scripts",
        join(pack, packageName),
      ],
      {
        stdio: "ignore",
        env: { ...process.env, npm_config_cache: emptyCache },
      },
    );
    const installedRoot = join(
      prefix,
      "node_modules",
      "@clockgrove",
      "factory",
    );
    const lock = JSON.parse(
      readFileSync(join(project, "package-lock.json"), "utf8"),
    );
    let checked = 0;
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || entry.dev) continue;
      const installedPath = join(installedRoot, path, "package.json");
      if (entry.optional && !existsSync(installedPath)) continue;
      assert.ok(
        existsSync(installedPath),
        `bundled dependency missing: ${path}`,
      );
      assert.equal(
        JSON.parse(readFileSync(installedPath, "utf8")).version,
        entry.version,
        path,
      );
      checked++;
    }
    assert.ok(
      checked > 90,
      `expected the complete production tree, got ${checked}`,
    );
    for (const path of [
      ".codex-plugin/plugin.json",
      "skills/director/SKILL.md",
      "skills/setup/SKILL.md",
      "THIRD_PARTY_NOTICES.md",
    ]) {
      assert.ok(
        existsSync(join(installedRoot, path)),
        `release asset missing: ${path}`,
      );
    }
    const cli = join(prefix, "node_modules", ".bin", "factory");
    const environment = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "xdg-config"),
      XDG_STATE_HOME: join(root, "xdg-state"),
    };
    const installed = execFileSync(
      cli,
      [
        "install",
        "--repository",
        "example/package-smoke",
        "--checkout",
        target.checkout,
        "--concurrency",
        "1",
        "--config",
        config,
      ],
      { encoding: "utf8", env: environment },
    );
    assert.match(installed, /Installed Factory for example\/package-smoke/);
    const installedConfig = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual(installedConfig.planning, {
      kind: "codex-sdk",
      planner: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
      reviewer: { model: "gpt-5.6-sol", reasoningEffort: "medium" },
    });
    assert.deepEqual(installedConfig.execution.harness, {
      kind: "codex-sdk",
      model: "gpt-5.6-sol",
      reasoningEffort: "medium",
    });
    const status = execFileSync(
      cli,
      ["status", "--objective", "1", "--config", config],
      { encoding: "utf8", env: environment },
    );
    assert.match(status, /no active Objective/);
    const installedPackage = await import(
      pathToFileURL(
        join(
          prefix,
          "node_modules",
          "@clockgrove",
          "factory",
          "dist",
          "index.js",
        ),
      ).href
    );
    const body = "# Packed Objective\n\n## Acceptance\n- `test -s one.txt`\n";
    const graph = {
      objective: 1,
      baseSha: target.baseSha,
      items: [
        {
          id: "one",
          title: "One",
          goal: "Create one.txt",
          acceptance: ["one.txt exists"],
          nonGoals: ["No deployment"],
          citations: [{ path: "OBJECTIVE", heading: "Acceptance" }],
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
          brief: "Create one.txt",
          sourceAssets: [],
          expectedOutputRoles: [],
          minimumAssetSets: 0,
          requiredLfsRoles: [],
        },
      ],
    };
    const application = installedPackage.createApplication(
      installedPackage.readConfig(config),
      {
        github: {
          async objective() {
            return { body, title: "Packed Objective" };
          },
        },
        planningModel: {
          async generateStructured() {
            return graph;
          },
          async reviewGraph() {
            return { findings: [] };
          },
        },
      },
    );
    const candidate = await application.planObjective(1);
    assert.equal(candidate.review.status, "clean");
    assert.equal(candidate.baseSha, target.baseSha);
    assert.equal(
      existsSync(
        join(
          installedPackage.stateRoot("example/package-smoke"),
          "objectives",
          "1",
          "state.json",
        ),
      ),
      false,
    );
    const json = JSON.parse(
      execFileSync(
        cli,
        ["status", "--objective", "1", "--json", "--config", config],
        { encoding: "utf8", env: environment },
      ),
    );
    assert.equal(json.state, "not-started");
    assert.deepEqual(json.work, []);
    const timeline = execFileSync(
      cli,
      ["diagnostics", "--objective", "1", "--config", config],
      { encoding: "utf8", env: environment },
    );
    assert.equal(timeline, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
