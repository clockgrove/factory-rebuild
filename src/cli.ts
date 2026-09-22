#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, readConfig, stateRoot, validateConfig } from "./config.js";
import { compose } from "./index.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

function help(): void {
  console.log(
    `Factory CLI\n\nCommands:\n  install --repository OWNER/REPO --checkout ABSOLUTE_PATH --concurrency N [--delivery regular|native-stack] [--network host|off] [--config PATH]\n  run [--config PATH]\n  status [--config PATH]\n  cancel [--config PATH]`,
  );
}

function main(): void {
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
    console.log(`Factory for ${config.repository}: no active Objective`);
  } else if (command === "cancel") {
    console.log("No active Objective to cancel");
  } else {
    throw new Error(
      "The Objective execution path is not available until Slice 1",
    );
  }
}

try {
  main();
} catch (error) {
  console.error(
    `Factory: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
