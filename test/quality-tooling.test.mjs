import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const biomeCli = join(
  repositoryRoot,
  "node_modules",
  "@biomejs",
  "biome",
  "bin",
  "biome",
);
const eslintCli = join(
  repositoryRoot,
  "node_modules",
  "eslint",
  "bin",
  "eslint.js",
);
const tscCli = join(repositoryRoot, "node_modules", "typescript", "bin", "tsc");

function runNodeCli(cli, args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return {
    output: `${result.stdout}${result.stderr}`,
    status: result.status,
  };
}

function repositoryPath(path) {
  return relative(repositoryRoot, path).split(sep).join("/");
}

function writeProbes(entries) {
  const directory = mkdtempSync(
    join(repositoryRoot, "src", "quality-tooling-probe-"),
  );
  const paths = [];
  for (const [name, source] of Object.entries(entries)) {
    const path = join(directory, name);
    writeFileSync(path, source);
    paths.push(path);
  }
  return { directory, paths };
}

test("Biome and TypeScript preserve the retired ESLint coverage", () => {
  const probes = writeProbes({
    "delete.ts": "let value;\ndelete value;\n",
    "expression.ts": "const value = 1;\nvalue as unknown;\n",
    "octal.ts": "export const value = 071;\n",
  });
  try {
    const biome = runNodeCli(biomeCli, [
      "lint",
      ...probes.paths.map(repositoryPath),
    ]);
    assert.notEqual(biome.status, 0);
    assert.match(
      biome.output,
      /target for a delete operator cannot be a single identifier/,
    );
    assert.match(biome.output, /"0"-prefixed octal literals are deprecated/);
    assert.match(biome.output, /lint\/suspicious\/noUnusedExpressions/);

    const typecheck = runNodeCli(tscCli, [
      "--noEmit",
      "--skipLibCheck",
      "--target",
      "ES2022",
      repositoryPath(probes.paths.find((path) => path.endsWith("octal.ts"))),
    ]);
    assert.notEqual(typecheck.status, 0);
    assert.match(typecheck.output, /TS1121: Octal literals are not allowed/);
  } finally {
    rmSync(probes.directory, { recursive: true, force: true });
  }
});

test("ESLint retains exactly the four unsupported Biome checks", () => {
  const probes = writeProbes({
    "invalid-regexp.ts": 'new RegExp("[");\n',
    "multiline.ts": 'export const value = functionValue\n("argument");\n',
    "triple-slash.ts": '/// <reference path="./types.d.ts" />\nexport {};\n',
    "ts-comment.ts": "// @ts-nocheck\nexport const value = 1;\n",
  });
  try {
    const paths = probes.paths.map(repositoryPath);
    const biome = runNodeCli(biomeCli, ["lint", ...paths]);
    assert.equal(biome.status, 0, biome.output);

    const eslint = runNodeCli(eslintCli, paths);
    assert.equal(eslint.status, 1, eslint.output);
    assert.match(eslint.output, /no-invalid-regexp/);
    assert.match(eslint.output, /no-unexpected-multiline/);
    assert.match(eslint.output, /@typescript-eslint\/ban-ts-comment/);
    assert.match(eslint.output, /@typescript-eslint\/triple-slash-reference/);

    const printed = runNodeCli(eslintCli, ["--print-config", paths[0]]);
    assert.equal(printed.status, 0, printed.output);
    const rules = Object.keys(JSON.parse(printed.output).rules).sort();
    assert.deepEqual(rules, [
      "@typescript-eslint/ban-ts-comment",
      "@typescript-eslint/triple-slash-reference",
      "no-invalid-regexp",
      "no-unexpected-multiline",
    ]);
  } finally {
    rmSync(probes.directory, { recursive: true, force: true });
  }
});

test("Prettier remains scoped to Biome-unsupported file surfaces", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts["format:check"],
    'biome format . && prettier --check package-lock.json "**/*.{md,yml,yaml}"',
  );
  assert.equal(
    packageJson.scripts.format,
    'biome format --write . && prettier --write package-lock.json "**/*.{md,yml,yaml}"',
  );
});
