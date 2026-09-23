#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, readConfig, stateRoot, validateConfig } from "./config.js";
import { compose } from "./index.js";
import { readState, runObjective } from "./runner.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

function help(): void {
  console.log(
    `Factory CLI\n\nCommands:\n  install --repository OWNER/REPO --checkout ABSOLUTE_PATH --concurrency N [--delivery regular|native-stack] [--network host|off] [--config PATH]\n  run --objective N [--config PATH]\n  status --objective N [--config PATH]\n  cancel [--config PATH]`,
  );
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "help" || command === "--help") return help();
  const path = option(args, "config") ?? configPath();
  if (command === "install") {
    const repository = option(args, "repository");
    const checkout = option(args, "checkout");
    const concurrency = Number(option(args, "concurrency"));
    if (!repository || !checkout || !option(args, "concurrency")) {
      throw new Error(
        "install requires --repository, --checkout, and --concurrency",
      );
    }
    const config = validateConfig({
      schemaVersion: 1,
      repository,
      checkout,
      planning: { kind: "codex-sdk" },
      execution: { kind: "local", concurrency, harness: { kind: "codex-sdk" } },
      delivery: { kind: option(args, "delivery") ?? "regular" },
      contentStore: { kind: "local" },
      policy: {
        network: option(args, "network") ?? "host",
        allowedSecretNames: [],
        deployments: "denied",
      },
    });
    if (existsSync(path) || existsSync(stateRoot(repository))) {
      throw new Error(
        "Factory installation requires an empty configuration and state root",
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Installed Factory for ${repository} at ${path}`);
    return;
  }
  if (!["run", "status", "cancel"].includes(command))
    throw new Error(`Unknown command: ${command}`);
  const config = readConfig(path);
  compose(config);
  if (command === "status") {
    const objective = Number(option(args, "objective"));
    const state = objective
      ? readState(config.repository, objective)
      : undefined;
    if (!state)
      console.log(`Factory for ${config.repository}: no active Objective`);
    else
      console.log(
        `Objective #${objective}: ${Object.entries(state.work)
          .map(
            ([id, work]) =>
              `${id} ${work.status}${work.step ? ` (${work.step})` : ""}`,
          )
          .join(
            ", ",
          )}; final validation ${state.finalValidation?.passed ? "passed" : state.error ? "failed" : "pending"}${state.error ? `; error: ${state.error}` : ""}`,
      );
  } else if (command === "cancel") {
    console.log("No active Objective to cancel");
  } else {
    const objective = Number(option(args, "objective"));
    if (!Number.isSafeInteger(objective) || objective <= 0)
      throw new Error("run requires --objective N");
    const state = await runObjective(config, objective);
    console.log(
      `Objective #${objective} completed at ${state.integratedSha}; final validation passed`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    `Factory: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
