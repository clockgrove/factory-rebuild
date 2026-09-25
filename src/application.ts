import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FactoryConfig } from "./config.js";
import { stateRoot, validateTarget } from "./config.js";
import { CodexPlanningModel, type PlanCandidate } from "./compiler.js";
import { LocalContentStore } from "./content/local.js";
import { NativeStackDelivery } from "./delivery/native-stack.js";
import { RegularDelivery } from "./delivery/regular.js";
import { CodexHarness, LocalExecutionDriver } from "./execution/local.js";
import { RealGitHubGateway } from "./github.js";
import type { FactoryState } from "./state.js";
import {
  cancelObjective,
  decideResult,
  decidePlan,
  exportAssetSetForReview,
  planObjective,
  retryWorkItem,
  runObjective,
  selectAssetSet,
  type ApplicationServices,
} from "./runner.js";

export interface FactoryApplication {
  planObjective(objective: number): Promise<PlanCandidate>;
  decidePlan(
    objective: number,
    candidate: PlanCandidate,
    input: {
      actor: string;
      outcome: "accept" | "refuse";
      answer: string;
      reason: string;
    },
  ): Promise<PlanCandidate>;
  runObjective(
    objective: number,
    acceptedPlan?: PlanCandidate,
  ): Promise<FactoryState>;
  cancelObjective(objective: number): Promise<"requested" | "cancelled">;
  retryWorkItem(objective: number, itemId: string): void;
  decideResult(
    objective: number,
    input: {
      item?: string;
      treeSha: string;
      actor: string;
      outcome: "accept" | "refuse";
      reason: string;
    },
  ): void;
  selectAssetSet(
    objective: number,
    itemId: string,
    setId: string,
    decision?: {
      actor?: string;
      reason?: string;
      downstreamItems?: string[];
      surface?: "factory-cli" | "application";
    },
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
    planObjective: (objective) => planObjective(config, objective, services),
    decidePlan: (objective, candidate, input) =>
      decidePlan(config, objective, services, candidate, input),
    runObjective: (objective, acceptedPlan) =>
      runObjective(config, objective, services, acceptedPlan),
    cancelObjective: (objective) =>
      cancelObjective(config, objective, services.driver),
    retryWorkItem: (objective, itemId) =>
      retryWorkItem(config, objective, itemId),
    decideResult: (objective, input) => decideResult(config, objective, input),
    selectAssetSet: (objective, itemId, setId, decision) =>
      selectAssetSet(
        config,
        objective,
        itemId,
        setId,
        services.contentStore,
        decision,
      ),
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

/** Planning composition never constructs a driver, content store, or run state. */
export function composePlanning(
  config: FactoryConfig,
): Pick<FactoryApplication, "planObjective" | "decidePlan"> {
  validateTarget(config.repository, config.checkout);
  const services = {
    planningModel: new CodexPlanningModel(
      config.checkout,
      config.planning.planner,
      config.planning.reviewer,
    ),
    github: new RealGitHubGateway(
      config.repository,
      new NativeStackDelivery(config.repository),
    ),
  };
  return {
    planObjective: (objective) => planObjective(config, objective, services),
    decidePlan: (objective, candidate, input) =>
      decidePlan(config, objective, services, candidate, input),
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
      config.execution.harness,
      config.policy.allowedSecretNames,
    ),
    config.execution.concurrency,
    contentStore,
  );
  return createApplication(config, {
    planningModel: new CodexPlanningModel(
      config.checkout,
      config.planning.planner,
      config.planning.reviewer,
    ),
    driver,
    github,
    delivery: new RegularDelivery(config.checkout, github),
    contentStore,
  });
}
