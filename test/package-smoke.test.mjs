import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTarget } from "./support/integration-fixture.mjs";

test("fresh packed artifact composes a registered harness through the package root", () => {
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
        "--omit=optional",
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
    const installedManifest = JSON.parse(
      readFileSync(join(installedRoot, "package.json"), "utf8"),
    );
    assert.deepEqual(installedManifest.optionalDependencies, {
      "@anthropic-ai/claude-agent-sdk": "0.3.281",
      "@github/copilot-sdk": "1.0.13",
    });
    const lock = JSON.parse(
      readFileSync(join(project, "package-lock.json"), "utf8"),
    );
    let checked = 0;
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path || entry.dev) continue;
      const installedPath = join(installedRoot, path, "package.json");
      if ((entry.optional || entry.devOptional) && !existsSync(installedPath))
        continue;
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
      "docs/AGENT-HARNESSES.md",
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
      model: "gpt-5.6-luna",
      reasoningEffort: "medium",
    });
    const status = execFileSync(
      cli,
      ["status", "--objective", "1", "--config", config],
      { encoding: "utf8", env: environment },
    );
    assert.match(status, /no active Objective/);
    assert.equal(
      existsSync(
        join(
          environment.XDG_STATE_HOME,
          "clockgrove-factory",
          "repositories",
          "example",
          "package-smoke",
          "objectives",
          "1",
          "state.json",
        ),
      ),
      false,
    );
    const before = JSON.parse(
      execFileSync(
        cli,
        ["status", "--objective", "1", "--json", "--config", config],
        { encoding: "utf8", env: environment },
      ),
    );
    assert.equal(before.state, "not-started");
    assert.deepEqual(before.work, []);

    const runner = join(prefix, "packed-harness-runner.mjs");
    copyFileSync(
      join(project, "test", "fixtures", "packed-harness-runner.mjs"),
      runner,
    );
    const credentialFreeEnvironment = Object.fromEntries(
      Object.entries(environment).filter(
        ([name]) => !/^(?:GH_|GITHUB_|ANTHROPIC_|OPENAI_|CLAUDE_)/.test(name),
      ),
    );
    const result = JSON.parse(
      execFileSync(process.execPath, [runner], {
        encoding: "utf8",
        cwd: prefix,
        env: {
          ...credentialFreeEnvironment,
          PACKED_TARGET_CHECKOUT: target.checkout,
          PACKED_FACTORY_CONFIG: config,
        },
      }),
    );
    assert.equal(result.adapter, "example/scripted-local@1");
    assert.equal(result.suppliedBase, target.baseSha);
    assert.equal(result.workerHeadUnchanged, true);
    assert.equal(result.validationPassed, true);
    assert.equal(result.pullRequest, 201);
    assert.equal(result.finalValidation, true);
    assert.match(result.changeRef, /^[0-9a-f]{40}$/);
    assert.match(result.treeSha, /^[0-9a-f]{40}$/);
    assert.match(result.integratedSha, /^[0-9a-f]{40}$/);

    const registeredConfig = JSON.parse(readFileSync(config, "utf8"));
    assert.deepEqual(registeredConfig.execution.harness, {
      kind: "registered",
      adapter: "example/scripted-local@1",
      config: {
        output: "packed harness",
        permissionMode: "worktree-only",
        settingsSources: [],
      },
    });
    const after = JSON.parse(
      execFileSync(
        cli,
        ["status", "--objective", "1", "--json", "--config", config],
        { encoding: "utf8", env: environment },
      ),
    );
    assert.equal(after.state, "complete");
    assert.equal(after.finalValidation, true);
    const timeline = execFileSync(
      cli,
      ["diagnostics", "--objective", "1", "--config", config],
      { encoding: "utf8", env: environment },
    );
    assert.match(timeline, /"operation":"harness"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
