import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lock = JSON.parse(
  readFileSync(resolve(root, "package-lock.json"), "utf8"),
);
const production = Object.entries(lock.packages)
  .filter(([path, entry]) => path && !entry.dev)
  .map(([path, entry]) => ({
    path,
    name: path.slice(
      path.lastIndexOf("node_modules/") + "node_modules/".length,
    ),
    version: entry.version,
    license: entry.license,
    optional: Boolean(entry.optional),
  }))
  .sort((a, b) => a.path.localeCompare(b.path));

if (!production.length || production.some((entry) => !entry.license)) {
  throw new Error("Production dependency licenses must be known");
}
const apache = readFileSync(
  resolve(root, "node_modules/@openai/codex-sdk/LICENSE"),
  "utf8",
).trimEnd();
if (!apache.includes("Apache License") || !apache.includes("Version 2.0")) {
  throw new Error("Installed SDK license text is not Apache-2.0");
}

function noticesFor(entry) {
  const directory = resolve(root, entry.path);
  const files = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) =>
          /^(license|licence|copying|notice)([-._]|$)/i.test(name),
        )
        .filter((name) => statSync(resolve(directory, name)).isFile())
        .sort()
    : [];
  if (files.length)
    return files.map((name) => ({
      source: `${entry.path}/${name}`,
      text: readFileSync(resolve(directory, name), "utf8")
        .replace(/\r\n?/g, "\n")
        .trimEnd(),
    }));
  if (entry.license === "Apache-2.0" && entry.name.startsWith("@openai/codex"))
    return [
      {
        source: "@openai/codex-sdk/LICENSE (same Apache-2.0 family)",
        text: apache,
      },
    ];
  if (["spdx-exceptions", "spdx-license-ids"].includes(entry.name))
    return [
      {
        source: `${entry.path}/README.md (publisher licensing statement)`,
        text: readFileSync(resolve(directory, "README.md"), "utf8")
          .replace(/\r\n?/g, "\n")
          .trimEnd(),
      },
    ];
  if (entry.name === "@azu/format-text")
    return [
      {
        source:
          "Published package metadata; no license file in package or upstream repository",
        text: "Author: azu. Declared license: BSD-3-Clause. Upstream: https://github.com/azu/format-text. The package omits a license text; resolve this attribution gap before public release.",
      },
    ];
  throw new Error(`Missing license notice for ${entry.path}`);
}

const notices = production.map((entry) => ({
  ...entry,
  notices: noticesFor(entry),
}));
const body =
  `# Third-party notices

Generated from the production dependencies in \`package-lock.json\` and their installed license files for Factory ${lock.version}. Re-run \`npm run notices\` after changing the dependency lock and review the result. Development-only tooling is excluded; optional platform packages are included.

| Package | Version | Declared license | Notice source |
| --- | --- | --- | --- |
${notices.map((entry) => `| \`${entry.name}\` | ${entry.version} | ${entry.license} | ${entry.notices.map((notice) => `\`${notice.source}\``).join(", ")} |`).join("\n")}

## Package notices

${notices.map((entry) => `### ${entry.name}@${entry.version}\n\n${entry.notices.map((notice) => `Source: \`${notice.source}\`\n\n\`\`\`\`text\n${notice.text}\n\`\`\`\``).join("\n\n")}\n`).join("\n")}
`.trimEnd() + "\n";

const target = resolve(root, "THIRD_PARTY_NOTICES.md");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== body)
    throw new Error("THIRD_PARTY_NOTICES.md is stale; run npm run notices");
} else {
  writeFileSync(target, body);
}
