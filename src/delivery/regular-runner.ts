import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FactoryConfig } from "../config.js";
import type { FactoryState } from "../state.js";
import type {
  ContentStore,
  DeliveryStrategy,
  ExecutionDriver,
  GitHubGateway,
  WorkItem,
} from "../contracts.js";
import { materializeAssetSet, selectedInputsForItem } from "../media.js";
import { closeWorkItem } from "../completion.js";
import { git } from "../process.js";
import { readyItems } from "../scheduler.js";
import { validateWorkItem } from "../validation.js";
import type { DiagnosticEmitter } from "../diagnostics.js";

export async function runRegularGraph(args: {
  config: FactoryConfig;
  objective: number;
  objectiveBody: string;
  root: string;
  state: FactoryState;
  driver: ExecutionDriver;
  delivery: DeliveryStrategy;
  contentStore: ContentStore;
  github: GitHubGateway;
  save: () => void;
  active: Map<string, Promise<void>>;
  cancelled: () => boolean;
  diagnostics?: DiagnosticEmitter;
}): Promise<boolean> {
  const {
    config,
    objective,
    root,
    state,
    driver,
    delivery,
    contentStore,
    github,
    save,
    active,
  } = args;
  const graph = state.graph;
  const baseSha = state.baseSha;
  let mergeTail: Promise<void> = Promise.resolve();
  const execute = async (
    item: WorkItem,
    itemBase: string,
    existingHandle?: NonNullable<FactoryState["work"][string]["execution"]>,
  ): Promise<void> => {
    const work = state.work[item.id]!;
    try {
      if (work.step === "approve-asset") {
        const selected = work.assets?.find(
          (set) => set.id === work.selectedAssetSet,
        );
        if (!selected || !work.changeRef)
          throw new Error("Selected AssetSet or captured change is missing");
        const materialize = () =>
          materializeAssetSet({
            checkout: config.checkout,
            workRoot: join(root, "asset-materialization"),
            baseCommit: work.changeRef!,
            item,
            set: selected,
            store: contentStore,
          });
        const applied = args.diagnostics
          ? await args.diagnostics.span(
              {
                runId: state.runId,
                itemId: item.id,
                attemptId: work.attempt,
                operation: "media-materialization",
                metadata: { setId: selected.id },
              },
              materialize,
              (result) => ({
                treeSha: result.treeSha,
                headSha: result.changeRef,
              }),
            )
          : await materialize();
        work.changeRef = applied.changeRef;
        work.treeSha = applied.treeSha;
      } else {
        const handle =
          existingHandle ??
          (await driver.start({
            item,
            baseSha: itemBase,
            attemptId: work.attempt,
            objectiveBody: args.objectiveBody,
            selectedAssets: selectedInputsForItem(state, item),
          }));
        if (!existingHandle) {
          work.execution = handle;
          save();
        }
        if (args.cancelled()) {
          await driver.cancel(handle);
          throw new Error("Objective cancelled");
        }
        const result = await driver.collect(handle);
        if (args.cancelled()) throw new Error("Objective cancelled");
        work.changeRef = result.changeRef;
        work.treeSha = result.treeSha;
        if (result.assets?.length) {
          work.assets = result.assets;
          work.status = "waiting";
          work.step = "approve-asset";
          save();
          return;
        }
      }
      work.step = "validate";
      save();
      work.validation = validateWorkItem(
        config.checkout,
        join(root, "validation"),
        item,
        work.changeRef!,
        work.treeSha!,
        (entry) =>
          args.diagnostics?.emit({
            runId: state.runId,
            itemId: item.id,
            attemptId: work.attempt,
            operation: "validation-command",
            outcome: entry.passed ? "completed" : "failed",
            durationMs: entry.durationMs,
            metadata: {
              commandIndex: entry.index,
              exitCode: entry.exitCode,
              treeSha: work.treeSha!,
            },
            detail: entry.output,
          }),
      );
      work.step = "deliver";
      save();
      const branch = `factory/objective-${objective}/${item.id}`;
      const publish = () =>
        delivery.publish({
          item,
          baseSha: itemBase,
          treeSha: work.treeSha!,
          changeRef: work.changeRef!,
          branch,
          lfs: Boolean(work.selectedAssetSet),
        });
      const published = args.diagnostics
        ? await args.diagnostics.span(
            {
              runId: state.runId,
              itemId: item.id,
              attemptId: work.attempt,
              operation: "github-publication",
              metadata: {
                baseSha: itemBase,
                treeSha: work.treeSha!,
                headSha: work.changeRef!,
              },
            },
            publish,
            (result) => ({ pullRequest: result.pullRequest }),
          )
        : await publish();
      work.pullRequest = published.pullRequest;
      save();
      const integrate = mergeTail.then(async () => {
        const merge = async () => {
          const merged = await delivery.merge(published);
          git(config.checkout, "fetch", "origin", github.defaultBranch());
          const observedHead = git(config.checkout, "rev-parse", "FETCH_HEAD");
          if (observedHead !== merged.integratedSha) {
            throw new Error(
              `Default branch moved after PR #${published.pullRequest} merged; expected ${merged.integratedSha}, observed ${observedHead}`,
            );
          }
          return observedHead;
        };
        const observedHead = args.diagnostics
          ? await args.diagnostics.span(
              {
                runId: state.runId,
                itemId: item.id,
                attemptId: work.attempt,
                operation: "github-merge",
                metadata: {
                  pullRequest: published.pullRequest,
                  headSha: work.changeRef!,
                },
              },
              merge,
              (headSha) => ({ integratedSha: headSha }),
            )
          : await merge();
        state.integratedSha = observedHead;
        work.integratedSha = observedHead;
        work.status = "done";
        work.completedAt = new Date().toISOString();
        delete work.step;
        save();
      });
      mergeTail = integrate.then(
        () => undefined,
        () => undefined,
      );
      await integrate;
      await closeWorkItem(state, item.id, github, save, false);
    } catch (error) {
      if (work.status !== "done")
        work.status = args.cancelled() ? "cancelled" : "failed";
      work.error = error instanceof Error ? error.message : String(error);
      save();
      throw error;
    }
  };
  for (const item of graph.items) {
    const work = state.work[item.id]!;
    if (work.status !== "running") continue;
    if (
      work.step === "approve-asset" &&
      work.selectedAssetSet &&
      work.baseSha
    ) {
      const promise = execute(item, work.baseSha).finally(() =>
        active.delete(item.id),
      );
      void promise.catch(() => undefined);
      active.set(item.id, promise);
      continue;
    }
    if (work.step !== "execute" || !work.execution || !work.baseSha) {
      throw new Error(
        `Work Item ${item.id} has ambiguous active state at ${work.step ?? "unknown"}; operator direction required`,
      );
    }
    const promise = execute(item, work.baseSha, work.execution).finally(() => {
      active.delete(item.id);
    });
    void promise.catch(() => undefined);
    active.set(item.id, promise);
  }
  while (graph.items.some((item) => state.work[item.id]?.status !== "done")) {
    if (args.cancelled()) throw new Error("Objective cancelled");
    const reported = await driver.availableSlots();
    const available =
      reported === "unknown" ? config.execution.concurrency : reported;
    const slots = Math.min(
      config.execution.concurrency - active.size,
      available,
    );
    const ready = readyItems(graph, state.work, new Set(active.keys()), slots);
    for (const item of ready) {
      const work = state.work[item.id]!;
      work.status = "running";
      work.step = "execute";
      work.attempt = randomUUID();
      work.startedAt = new Date().toISOString();
      const itemBase = state.integratedSha ?? baseSha;
      work.baseSha = itemBase;
      save();
      const promise = execute(item, itemBase).finally(() => {
        active.delete(item.id);
      });
      void promise.catch(() => undefined);
      active.set(item.id, promise);
    }
    if (
      !active.size &&
      graph.items.some((item) => state.work[item.id]?.status === "waiting")
    )
      return true;
    if (!active.size)
      throw new Error("No ready Work Item; graph cannot progress");
    await Promise.race(active.values());
  }
  return false;
}
