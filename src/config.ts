import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

export type ExecutionConfig =
  | { kind: "local"; concurrency: number; harness: { kind: "codex-sdk" } }
  | { kind: "managed-agent"; concurrency: number; provider: string }
  | {
      kind: "sandbox";
      concurrency: number;
      provider: string;
      harness: { kind: string };
    };

export interface FactoryConfig {
  schemaVersion: 1;
  repository: string;
  checkout: string;
  planning: { kind: "codex-sdk" };
  execution: ExecutionConfig;
  delivery: { kind: "regular" | "native-stack" };
  contentStore: { kind: "local" };
  policy: {
    network: "host" | "off";
    allowedSecretNames: string[];
    deployments: "denied";
  };
}

const factoryNames = new Set(["factory", "factory-rebuild", "factory-archive"]);

function assertObject(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function remoteRepository(checkout: string): string | undefined {
  try {
    const origin = execFileSync(
      "git",
      ["-C", checkout, "remote", "get-url", "origin"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    const match = origin.match(
      /(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?$/i,
    );
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function validateTarget(repository: string, checkout: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("repository must be an owner/name GitHub repository");
  }
  if (!isAbsolute(checkout) || !existsSync(checkout)) {
    throw new Error("checkout must be an existing absolute directory");
  }
  const actual = realpathSync(checkout);
  const repo = repository.toLowerCase();
  const remote = remoteRepository(actual);
  if (
    factoryNames.has(repo.split("/")[1] ?? "") ||
    factoryNames.has(basename(actual).toLowerCase()) ||
    (remote && factoryNames.has(remote.split("/")[1] ?? ""))
  ) {
    throw new Error(
      "Factory cannot be installed or run against a Factory repository",
    );
  }
  if (remote && remote !== repo) {
    throw new Error(
      `checkout origin ${remote} does not match configured repository ${repo}`,
    );
  }
  try {
    execFileSync("git", ["-C", actual, "rev-parse", "--show-toplevel"], {
      stdio: "ignore",
    });
  } catch {
    throw new Error("checkout must be a Git repository");
  }
}

export function validateConfig(value: unknown): FactoryConfig {
  assertObject(value, "configuration");
  if (value.schemaVersion !== 1)
    throw new Error("Only Factory schemaVersion 1 is supported");
  if (
    typeof value.repository !== "string" ||
    typeof value.checkout !== "string"
  ) {
    throw new Error("repository and checkout are required");
  }
  validateTarget(value.repository, value.checkout);
  assertObject(value.planning, "planning");
  if (value.planning.kind !== "codex-sdk")
    throw new Error("Unsupported planning model");
  assertObject(value.execution, "execution");
  if (value.execution.kind !== "local") {
    throw new Error(
      `Execution mode ${String(value.execution.kind)} is not implemented; select local`,
    );
  }
  if (
    !Number.isSafeInteger(value.execution.concurrency) ||
    (value.execution.concurrency as number) <= 0
  ) {
    throw new Error(
      "execution.concurrency must be a positive operator-selected integer",
    );
  }
  assertObject(value.execution.harness, "execution.harness");
  if (value.execution.harness.kind !== "codex-sdk")
    throw new Error("Unsupported local harness");
  assertObject(value.delivery, "delivery");
  if (
    value.delivery.kind !== "regular" &&
    value.delivery.kind !== "native-stack"
  ) {
    throw new Error("Unsupported delivery strategy");
  }
  assertObject(value.contentStore, "contentStore");
  if (value.contentStore.kind !== "local")
    throw new Error("Unsupported content store");
  assertObject(value.policy, "policy");
  if (value.policy.network !== "host" && value.policy.network !== "off")
    throw new Error("Unsupported network policy");
  if (
    !Array.isArray(value.policy.allowedSecretNames) ||
    !value.policy.allowedSecretNames.every(
      (name: unknown) => typeof name === "string",
    )
  ) {
    throw new Error("policy.allowedSecretNames must be a string array");
  }
  if (value.policy.deployments !== "denied")
    throw new Error("Deployments are unsupported");
  return value as unknown as FactoryConfig;
}

export function configPath(): string {
  const root =
    process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
  return resolve(root, "clockgrove-factory", "config.json");
}

export function stateRoot(repository: string): string {
  const root =
    process.env.XDG_STATE_HOME ??
    join(process.env.HOME ?? "", ".local", "state");
  const [owner, repo] = repository.split("/");
  return resolve(root, "clockgrove-factory", "repositories", owner!, repo!);
}

export function readConfig(path = configPath()): FactoryConfig {
  return validateConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
}
