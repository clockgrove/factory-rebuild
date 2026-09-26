import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const { satisfies } = createRequire(import.meta.url)("semver");

test("complete default production dependency graph supports Node 22.0.0", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url)),
  );
  const lock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url)),
  );
  assert.equal(manifest.engines.node, ">=22");
  assert.equal(manifest.dependencies["@secretlint/node"], "13.0.5");
  assert.equal(
    lock.packages["node_modules/@secretlint/secretlint-rule-preset-recommend"]
      .version,
    "13.0.5",
  );
  assert.ok(manifest.bundleDependencies.includes("@secretlint/node"));
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (entry.dev || entry.optional) continue;
    if (entry.engines?.node)
      assert.ok(
        satisfies("22.0.0", entry.engines.node),
        `${path}@${entry.version}: ${entry.engines.node}`,
      );
    assert.ok(
      !/node_modules\/(?:secretlint|read-pkg|normalize-package-data|hosted-git-info)$/.test(
        path,
      ),
      path,
    );
  }
});
