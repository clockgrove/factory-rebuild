import { Codex } from "@openai/codex-sdk";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { HarnessRequest } from "../contracts.js";

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
  const prompt = `Implement this Work Item in the current repository checkout. Change only the owned paths. Do not commit, push, create issues, create pull requests, or access GitHub credentials. Stop and report if acceptance is impossible.\n\nTitle: ${request.item.title}\nGoal: ${request.item.goal}\nAcceptance:\n${request.item.acceptance.join("\n")}\nNon-goals:\n${request.item.nonGoals.join("\n")}\nOwned paths:\n${request.item.ownedPaths.join("\n")}\nBrief:\n${request.item.brief}`;
  try {
    const result = await thread.run(prompt);
    writeResult(resultPath, {
      state: "complete",
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
