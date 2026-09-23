import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
);
const production = Object.entries(lock.packages)
  .filter(([path, entry]) => path && !entry.dev)
  .map(([path, entry]) => ({
    name: path.slice(
      path.lastIndexOf("node_modules/") + "node_modules/".length,
    ),
    version: entry.version,
    license: entry.license,
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

if (!production.length || production.some((entry) => !entry.license)) {
  throw new Error("Production dependency licenses must be known");
}
if (production.some((entry) => entry.license !== "Apache-2.0")) {
  throw new Error(
    "Update notice license texts for changed production licenses",
  );
}

const apache = readFileSync(
  resolve(root, "node_modules/@openai/codex-sdk/LICENSE"),
  "utf8",
).trimEnd();
if (!apache.includes("Apache License") || !apache.includes("Version 2.0")) {
  throw new Error("Installed SDK license text is not Apache-2.0");
}

const body = `# Third-party notices

Generated from the production dependencies in \`package-lock.json\` for Factory ${lock.version}. Re-run \`npm run notices\` after changing the dependency lock and review the resulting license text. Development-only tooling is excluded from the installed package notice list.

| Package | Version | License |
| --- | --- | --- |
${production.map((entry) => `| \`${entry.name}\` | ${entry.version} | ${entry.license} |`).join("\n")}

The packages above are distributed under the following license text:

\`\`\`text
${apache}
\`\`\`
`;

const target = resolve(root, "THIRD_PARTY_NOTICES.md");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== body)
    throw new Error("THIRD_PARTY_NOTICES.md is stale; run npm run notices");
} else {
  writeFileSync(target, body);
}
