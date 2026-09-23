import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
    const sdkPackage = execFileSync(
      "npm",
      [
        "pack",
        "--silent",
        "--pack-destination",
        pack,
        "node_modules/@openai/codex-sdk",
      ],
      { cwd: project, encoding: "utf8" },
    ).trim();
    const codexPackage = execFileSync(
      "npm",
      [
        "pack",
        "--silent",
        "--pack-destination",
        pack,
        "node_modules/@openai/codex",
      ],
      { cwd: project, encoding: "utf8" },
    ).trim();
    execFileSync(
      "npm",
      [
        "install",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--omit=optional",
        join(pack, packageName),
        join(pack, sdkPackage),
        join(pack, codexPackage),
      ],
      { stdio: "ignore" },
    );
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
