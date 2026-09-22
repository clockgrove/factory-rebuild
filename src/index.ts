export * from "./contracts.js";
export * from "./config.js";
export * from "./state.js";

import type { FactoryConfig } from "./config.js";

export function compose(config: FactoryConfig): {
  mode: "local";
  delivery: "regular" | "native-stack";
} {
  if (config.execution.kind !== "local") {
    throw new Error(
      `Execution mode ${config.execution.kind} is not implemented`,
    );
  }
  return { mode: "local", delivery: config.delivery.kind };
}
