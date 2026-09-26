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

test("non-identical Biome mappings retain recommended-rule coverage", () => {
  const probes = writeProbes({
    "arguments.ts": "export function first() { return arguments[0]; }\n",
    "assignment.ts":
      "export function assign(value, next) { if (value = next) return value; return value; }\n",
    "banned-types.ts":
      "export type EmptyObject = {};\nexport type UnsafeFunction = Function;\nexport type WrappedObject = String;\n",
    "commonjs.ts":
      'const moduleValue = require("node:fs");\nexport { moduleValue };\n',
    "empty.ts": "export function empty() {}\n",
    "regex.ts":
      "export const spaced = /a  b/;\nexport const escaped = /\\a/;\n",
    "spread.ts":
      "export function invoke(fn, args) { return fn.apply(undefined, args); }\n",
    "this-alias.ts":
      "export function identity() { const self = this; return self; }\n",
  });
  try {
    const biome = runNodeCli(biomeCli, [
      "lint",
      ...probes.paths.map(repositoryPath),
    ]);
    assert.notEqual(biome.status, 0);
    for (const category of [
      "lint/complexity/noAdjacentSpacesInRegex",
      "lint/complexity/noArguments",
      "lint/complexity/noBannedTypes",
      "lint/complexity/noUselessEscapeInRegex",
      "lint/complexity/noUselessThisAlias",
      "lint/suspicious/noAssignInExpressions",
      "lint/suspicious/noEmptyBlockStatements",
      "lint/style/noCommonJs",
      "lint/style/useSpreadOverApply",
    ]) {
      assert.match(biome.output, new RegExp(category.replaceAll("/", "\\/")));
    }
  } finally {
    rmSync(probes.directory, { recursive: true, force: true });
  }
});

test("ESLint retains the demonstrated unsupported Biome checks", () => {
  const probes = writeProbes({
    "empty-object.ts":
      "export interface EmptyInterface {}\nexport interface SingleExtension extends EmptyInterface {}\n",
    "invalid-regexp.ts": 'new RegExp("[");\n',
    "multiline.ts": 'export const value = functionValue\n("argument");\n',
    "triple-slash.ts": '/// <reference path="./types.d.ts" />\nexport {};\n',
    "ts-comment.ts": "// @ts-nocheck\nexport const value = 1;\n",
    "useless-escape.ts":
      'export const stringValue = "foo\\;bar";\nexport const templateValue = `foo\\;bar`;\n',
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
    assert.match(eslint.output, /@typescript-eslint\/no-empty-object-type/);
    assert.match(eslint.output, /@typescript-eslint\/triple-slash-reference/);
    assert.match(eslint.output, /no-useless-escape/);

    const printed = runNodeCli(eslintCli, ["--print-config", paths[0]]);
    assert.equal(printed.status, 0, printed.output);
    const rules = Object.keys(JSON.parse(printed.output).rules).sort();
    assert.deepEqual(rules, [
      "@typescript-eslint/ban-ts-comment",
      "@typescript-eslint/no-empty-object-type",
      "@typescript-eslint/triple-slash-reference",
      "no-invalid-regexp",
      "no-unexpected-multiline",
      "no-useless-escape",
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

test("residual ESLint supports the complete documented Node range", () => {
  const packageJson = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  const eslintPackage = JSON.parse(
    readFileSync(
      join(repositoryRoot, "node_modules", "eslint", "package.json"),
      "utf8",
    ),
  );
  const typescriptEslintPackage = JSON.parse(
    readFileSync(
      join(repositoryRoot, "node_modules", "typescript-eslint", "package.json"),
      "utf8",
    ),
  );
  const visitorKeysPackage = JSON.parse(
    readFileSync(
      join(
        repositoryRoot,
        "node_modules",
        "eslint-visitor-keys",
        "package.json",
      ),
      "utf8",
    ),
  );
  assert.equal(packageJson.engines.node, ">=22");
  assert.equal(packageJson.devDependencies.eslint, "9.39.5");
  assert.equal(packageJson.devDependencies["typescript-eslint"], "8.44.1");
  assert.equal(eslintPackage.engines.node, "^18.18.0 || ^20.9.0 || >=21.1.0");
  assert.equal(
    typescriptEslintPackage.engines.node,
    "^18.18.0 || ^20.9.0 || >=21.1.0",
  );
  assert.equal(
    visitorKeysPackage.engines.node,
    "^18.18.0 || ^20.9.0 || >=21.1.0",
  );
});
