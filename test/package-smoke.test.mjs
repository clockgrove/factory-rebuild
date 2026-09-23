import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createTarget } from "./support/integration-fixture.mjs";

test("fresh packed artifact installs and exposes documented install/status commands", () => {
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
        "--offline",
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
