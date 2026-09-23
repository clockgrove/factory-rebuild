#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath, readConfig, stateRoot, validateConfig } from "./config.js";
import { compose } from "./index.js";
import { readState } from "./state-store.js";
import { itemsConflict } from "./scheduler.js";
import { linearDeliveryUnits } from "./delivery/plan.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? undefined : args[index + 1];
}

function help(): void {
  console.log(
    `Factory CLI\n\nCommands:\n  install --repository OWNER/REPO --checkout ABSOLUTE_PATH --concurrency N [--delivery regular|native-stack] [--network host|off] [--config PATH]\n  run --objective N [--config PATH]\n  status --objective N [--config PATH]\n  review --objective N --item ID --set SET_ID --output ABSOLUTE_NEW_DIRECTORY [--config PATH]\n  select --objective N --item ID --set SET_ID [--config PATH]\n  cancel --objective N [--config PATH]\n  retry --objective N --item ID [--config PATH]`,
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
  if (
    !["run", "status", "review", "select", "cancel", "retry"].includes(command)
  )
    throw new Error(`Unknown command: ${command}`);
  const config = readConfig(path);
  const application = compose(config);
  const objective = Number(option(args, "objective"));
  if (!Number.isSafeInteger(objective) || objective <= 0)
    throw new Error(`${command} requires --objective N`);
  if (command === "status") {
    const state = readState(config.repository, objective);
    if (!state)
      console.log(`Factory for ${config.repository}: no active Objective`);
    else {
      const unitByItem = new Map(
        linearDeliveryUnits(state.graph).flatMap((unit) =>
          unit.items.map((item) => [item.id, unit.id] as const),
        ),
      );
      const describe = (id: string): string => {
        const work = state.work[id]!;
        if (work.status !== "pending")
          return `${id} ${work.status}${work.step ? ` (${work.step})` : ""}`;
        const item = state.graph.items.find(
          (candidate) => candidate.id === id,
        )!;
        const dependency = item.dependencies.find(
          (name) =>
            state.work[name]?.status !== "done" &&
            !(
              config.delivery.kind === "native-stack" &&
              state.work[name]?.status === "published" &&
              unitByItem.get(name) === unitByItem.get(id)
            ),
        );
        if (dependency) return `${id} waiting for ${dependency}`;
        const conflict = state.graph.items.find(
          (candidate) =>
            state.work[candidate.id]?.status === "running" &&
            itemsConflict(item, candidate),
        );
        return conflict
          ? `${id} waiting for ${conflict.id} path/resource`
          : `${id} ready`;
      };
      console.log(
        `Objective #${objective}: ${state.graph.items.map((item) => describe(item.id)).join(", ")}; final validation ${state.finalValidation?.passed ? "passed" : state.cancelledAt ? "cancelled" : state.error ? "failed" : "pending"}${state.error ? `; error: ${state.error}` : ""}`,
      );
      for (const [id, work] of Object.entries(state.work)) {
        if (work.status !== "waiting" || work.step !== "approve-asset")
          continue;
        console.log(`Work Item ${id} awaits selection. Candidate AssetSets:`);
        for (const set of work.assets ?? [])
          console.log(
            `  ${set.id}: ${set.members.map((member) => `${member.role} → ${member.destination} (${member.ref.digest})`).join(", ")}`,
          );
      }
    }
  } else if (command === "cancel") {
    const result = await application.cancelObjective(objective);
    console.log(`Objective #${objective} cancellation ${result}`);
  } else if (command === "retry") {
    const item = option(args, "item");
    if (!item) throw new Error("retry requires --item ID");
    application.retryWorkItem(objective, item);
    console.log(`Work Item ${item} is pending for a new explicit attempt`);
  } else if (command === "select") {
    const item = option(args, "item");
    const set = option(args, "set");
    if (!item || !set) throw new Error("select requires --item and --set");
    await application.selectAssetSet(objective, item, set);
    console.log(
      `Selected AssetSet ${set} for Work Item ${item}; run the Objective to continue`,
    );
  } else if (command === "review") {
    const item = option(args, "item");
    const set = option(args, "set");
    const output = option(args, "output");
    if (!item || !set || !output)
      throw new Error("review requires --item, --set, and --output");
    await application.exportAssetSetForReview(objective, item, set, output);
    console.log(`Exported AssetSet ${set} to ${output} for review`);
  } else {
    const state = await application.runObjective(objective);
    console.log(
      state.finalValidation?.passed
        ? `Objective #${objective} completed at ${state.integratedSha}; final validation passed`
        : `Objective #${objective} awaits asset selection; use status, select, then run`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(
    `Factory: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
