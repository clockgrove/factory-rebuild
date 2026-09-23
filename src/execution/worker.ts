import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HarnessRequest } from "../contracts.js";
import { parseProducedAssetSets } from "../media.js";

interface WorkerInput {
  request: HarnessRequest;
  network: "host" | "off";
}

function writeResult(path: string, value: unknown): void {
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

async function main(): Promise<void> {
  const [inputPath, resultPath] = process.argv.slice(2);
  if (!inputPath || !resultPath)
    throw new Error("Worker requires input and result paths");
  const { request, network } = JSON.parse(
    readFileSync(inputPath, "utf8"),
  ) as WorkerInput;
  const codex = new Codex({
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  const thread = codex.startThread({
    workingDirectory: request.worktree,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: network === "host",
  });
  const mediaInstructions = request.item.expectedOutputRoles?.length
    ? `\n\nProduce at least ${request.item.minimumAssetSets ?? 1} complete candidate AssetSets with different content. Put candidate bytes under .factory-media/ and write .factory-assets.json at the checkout root. Use this format-neutral manifest shape, replacing every angle-bracket placeholder with the actual declared role, file, media type, and owned destination: {"sets":[{"id":"candidate-a","members":[{"role":"<expected role>","path":".factory-media/candidate-a/<file>","mediaType":"<declared media type>","destination":"<owned target path>"}],"provenance":{"source":"<source path or generated>","rights":"<basis for repository use>","visibility":"repository","lineage":["<source path or input identity>"]}}]}. Include every expected role in each set. You may add member formatMetadata with a named source and uninterpreted values when an authoritative tool supplies it, and set-level relationships with from, toRole, and kind when outputs are related. Do not invent metadata or tool identities. .factory-media/ and .factory-assets.json are the only staging exceptions to owned paths. Do not write final destinations directly. Candidate files and the manifest are staging outputs; do not commit them. The controller will preserve the exact bytes for human review and selection.\nSource bindings: ${JSON.stringify(request.sourceAssets ?? [])}\nExpected output roles: ${request.item.expectedOutputRoles.join(", ")}`
    : "";
  const prompt = `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${request.item.title}\nGoal: ${request.item.goal}\nAcceptance:\n${request.item.acceptance.join("\n")}\nNon-goals:\n${request.item.nonGoals.join("\n")}\nOwned paths:\n${request.item.ownedPaths.join("\n")}\nBrief:\n${request.item.brief}${mediaInstructions}`;
  try {
    const result = await thread.run(prompt);
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
        : parseProducedAssetSets(
            (manifestValue as Record<string, unknown>).sets,
          );
    if (
      request.item.expectedOutputRoles?.length &&
      (!parsedAssets ||
        parsedAssets.length < (request.item.minimumAssetSets ?? 1))
    )
      throw new Error(
        "Media Work Item did not declare the requested complete AssetSets",
      );
    writeResult(resultPath, {
      state: "complete",
      assets: parsedAssets,
      evidence: {
        finalResponse: result.finalResponse,
        threadId: thread.id,
        usage: result.usage,
      },
    });
  } catch (error) {
    writeResult(resultPath, {
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exitCode = 1;
});
