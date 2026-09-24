import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HarnessRequest, ProducedAssetSet } from "../contracts.js";
import { parseProducedAssetSets } from "../media.js";

export function privateProgress(path: string, event: unknown): void {
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_APPEND |
      constants.O_CREAT |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fstatSync(fd).isFile() || (fstatSync(fd).mode & 0o077) !== 0)
      throw new Error("Worker progress file is not a restricted regular file");
    appendFileSync(fd, `${JSON.stringify(event)}\n`);
  } finally {
    closeSync(fd);
  }
}

export function redact(value: string, secrets: string[]): string {
  let result = value.replace(
    /\b(?:gh[pousr]_|github_pat_|sk-ant-|sk-)[A-Za-z0-9_-]{8,}\b/g,
    "[REDACTED]",
  );
  for (const secret of secrets)
    if (secret.length) result = result.split(secret).join("[REDACTED]");
  return result;
}

export function authenticationFailure(
  provider: "codex" | "claude" | "github-copilot",
  error: unknown,
):
  | {
      state: "failed";
      error: string;
      authentication: { provider: string; command: string };
    }
  | undefined {
  const detail = error instanceof Error ? error.message : String(error);
  if (
    !/(?:no authentication|not authenticated|not logged in|not signed in|login required|sign in required|authentication required|please (?:run )?(?:\/login|login)|authentication(?:_| )failed|unauthenticated|unauthorized|invalid authentication|oauth.*(?:expired|invalid)|\b401\b)/i.test(
      detail,
    )
  )
    return undefined;
  const commands = {
    codex: "codex login",
    claude: "claude auth login",
    "github-copilot": "copilot auth login",
  } as const;
  const command = commands[provider];
  return {
    state: "failed",
    error: `Authentication required for ${provider}; run \`${command}\` in the developer environment, then retry the Work Item`,
    authentication: { provider, command },
  };
}

export function writeHarnessResult(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function workItemPrompt(request: HarnessRequest): string {
  const mediaInstructions = request.item.expectedOutputRoles?.length
    ? `\n\nProduce at least ${request.item.minimumAssetSets ?? 1} complete candidate AssetSets with different content. Put candidate bytes under .factory-media/ and write .factory-assets.json at the checkout root. Use this format-neutral manifest shape, replacing every angle-bracket placeholder with the actual declared role, file, media type, and owned destination: {"sets":[{"id":"candidate-a","members":[{"role":"<expected role>","path":".factory-media/candidate-a/<file>","mediaType":"<declared media type>","destination":"<owned target path>"}],"provenance":{"source":"<source path or generated>","rights":"<basis for repository use>","visibility":"repository","lineage":["<source path or input identity>"]}}]}. Include every expected role in each set. You may add member formatMetadata with a named source and uninterpreted values when an authoritative tool supplies it, set-level relationships with from, toRole, and kind when outputs are related, and production evidence with model, tool, request, or parameters when those values are actually supplied. Do not invent metadata or tool identities. .factory-media/ and .factory-assets.json are the only staging exceptions to owned paths. Do not write final destinations directly. Candidate files and the manifest are staging outputs; do not commit them. The controller will preserve the exact bytes for human review and selection.\nSource bindings: ${JSON.stringify(request.sourceAssets ?? [])}\nExpected output roles: ${request.item.expectedOutputRoles.join(", ")}`
    : "";
  const inputInstructions =
    request.selectedAssets?.length ||
    request.sourceAssets?.some((source) => source.path)
      ? `\n\nAuthorized read-only asset inputs (files are removed before delivery; do not edit or commit them): ${JSON.stringify(
          {
            selected: request.selectedAssets ?? [],
            privateSources:
              request.sourceAssets?.filter((source) => source.path) ?? [],
          },
        )}`
      : "";
  return `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${request.item.title}\nGoal: ${request.item.goal}\nAcceptance:\n${request.item.acceptance.join("\n")}\nNon-goals:\n${request.item.nonGoals.join("\n")}\nOwned paths:\n${request.item.ownedPaths.join("\n")}\nBrief:\n${request.item.brief}${mediaInstructions}${inputInstructions}`;
}

export function readProducedAssets(
  request: HarnessRequest,
): ProducedAssetSet[] | undefined {
  const manifest = join(request.worktree, ".factory-assets.json");
  if (
    existsSync(manifest) &&
    (!lstatSync(manifest).isFile() ||
      realpathSync(manifest) !== resolve(manifest))
  )
    throw new Error("AssetSet manifest is not a regular staging file");
  const manifestValue: unknown = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8"))
    : undefined;
  if (
    manifestValue !== undefined &&
    (!manifestValue ||
      typeof manifestValue !== "object" ||
      Array.isArray(manifestValue))
  )
    throw new Error("AssetSet manifest must be an object with sets");
  const parsedAssets =
    manifestValue === undefined
      ? undefined
      : parseProducedAssetSets((manifestValue as Record<string, unknown>).sets);
  if (
    request.item.expectedOutputRoles?.length &&
    (!parsedAssets ||
      parsedAssets.length < (request.item.minimumAssetSets ?? 1))
  )
    throw new Error(
      "Media Work Item did not declare the requested complete AssetSets",
    );
  return parsedAssets;
}
