import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "./config.js";
import { stateRoot, validateTarget } from "./config.js";
import { CodexPlanningModel } from "./compiler.js";
import { LocalContentStore } from "./content/local.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { RegularDelivery } from "./delivery/regular.js";
import { CodexHarness, LocalExecutionDriver } from "./execution/local.js";
import { RealGitHubGateway } from "./github.js";
import type { FactoryState } from "./state.js";
import {
  cancelObjective,
  exportAssetSetForReview,
  retryWorkItem,
  runObjective,
  selectAssetSet,
  type ApplicationServices,
} from "./runner.js";

export interface FactoryApplication {
  runObjective(objective: number): Promise<FactoryState>;
  cancelObjective(objective: number): Promise<"requested" | "cancelled">;
  retryWorkItem(objective: number, itemId: string): void;
  selectAssetSet(
    objective: number,
    itemId: string,
    setId: string,
  ): Promise<void>;
  exportAssetSetForReview(
    objective: number,
    itemId: string,
    setId: string,
    output: string,
  ): Promise<void>;
}

export function createApplication(
  config: FactoryConfig,
  services: ApplicationServices,
): FactoryApplication {
  return {
    runObjective: (objective) => runObjective(config, objective, services),
    cancelObjective: (objective) =>
      cancelObjective(config, objective, services.driver),
    retryWorkItem: (objective, itemId) =>
      retryWorkItem(config, objective, itemId),
    selectAssetSet: (objective, itemId, setId) =>
      selectAssetSet(config, objective, itemId, setId, services.contentStore),
    exportAssetSetForReview: (objective, itemId, setId, output) =>
      exportAssetSetForReview(
        config,
        objective,
        itemId,
        setId,
        output,
        services.contentStore,
      ),
  };
}

/** The single production composition point for the installed application. */
export function compose(config: FactoryConfig): FactoryApplication {
  validateTarget(config.repository, config.checkout);
  if (config.execution.kind !== "local")
    throw new Error(
      `Execution mode ${config.execution.kind} is not implemented`,
    );
  const root = stateRoot(config.repository);
  const credentials = join(root, "empty-gh-config");
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const contentStore = new LocalContentStore(join(root, "content"));
  const github = new RealGitHubGateway(
    config.repository,
    new NativeStackDelivery(config.repository),
  );
  const driver = new LocalExecutionDriver(
    config.checkout,
    join(root, "worktrees"),
    new CodexHarness(
      credentials,
      config.policy.network,
      config.policy.allowedSecretNames,
    ),
    config.execution.concurrency,
    contentStore,
  );
  return createApplication(config, {
    planningModel: new CodexPlanningModel(config.checkout),
    driver,
    github,
    delivery: new RegularDelivery(config.checkout, github),
    contentStore,
  });
}
