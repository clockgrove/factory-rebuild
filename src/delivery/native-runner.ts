import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { FactoryState } from "../state.js";
import type { FactoryConfig } from "../config.js";
import type { ExecutionHandle } from "../contracts.js";
import { LocalExecutionDriver } from "../execution/local.js";
import { RealGitHubGateway } from "../github.js";
import { git } from "../process.js";
import { validateWorkItem } from "../validation.js";
import { RegularDelivery } from "./regular.js";
import { linearDeliveryUnits } from "./plan.js";
import { NativeStackDelivery, type StackLayer } from "./native-stack.js";
import { LocalContentStore } from "../content/local.js";
import { materializeAssetSet } from "../media.js";

export async function runNativeGraph(args: {
  config: FactoryConfig;
  objective: number;
  root: string;
  state: FactoryState;
  driver: LocalExecutionDriver;
  github: RealGitHubGateway;
  save: () => void;
  active: Map<string, Promise<void>>;
  cancelled: () => boolean;
}): Promise<void> {
  const { config, objective, root, state, driver, github, save, active } = args;
  const commits = new Map<string, string>();
  const regular = new RegularDelivery(config.checkout, github, commits);
  const native = new NativeStackDelivery(config.repository);
  const contentStore = new LocalContentStore(join(root, "content"));
  const branchFor = (id: string) => `factory/objective-${objective}/${id}`;
  const defaultBranch = github.defaultBranch();
  for (const unit of linearDeliveryUnits(state.graph)) {
    if (unit.items.every((item) => state.work[item.id]?.status === "done"))
      continue;
    if (
      !unit.externalDependencies.every(
        (dependency) => state.work[dependency]?.status === "done",
      )
    ) {
      throw new Error(
        `Delivery unit ${unit.id} started before its dependencies`,
      );
    }
    for (const [index, item] of unit.items.entries()) {
      if (args.cancelled()) throw new Error("Objective cancelled");
      const work = state.work[item.id]!;
      if (work.status === "published") continue;
      if (state.work[item.id]?.status === "waiting") return;
      if (work.status !== "pending" && work.status !== "running")
        throw new Error(`Work Item ${item.id} cannot enter native delivery`);
      const previous = index ? state.work[unit.items[index - 1]!.id]! : null;
      const itemBase = previous
        ? previous.changeRef
        : (state.integratedSha ?? state.baseSha);
      if (!itemBase) throw new Error("Native stack predecessor has no commit");
      if (work.status === "running" && work.baseSha !== itemBase)
        throw new Error(`Work Item ${item.id} resumed on a changed base`);
      if (work.status === "pending") {
        work.status = "running";
        work.step = "execute";
        work.baseSha = itemBase;
        work.attempt = randomUUID();
        work.startedAt = new Date().toISOString();
        save();
      }
      if (
        (work.step !== "execute" && work.step !== "approve-asset") ||
        (work.execution && !work.attempt)
      )
        throw new Error(
          `Work Item ${item.id} has ambiguous active state; operator direction required`,
        );
      const perform = async (): Promise<void> => {
        if (work.step === "approve-asset") {
          const selected = work.assets?.find(
            (set) => set.id === work.selectedAssetSet,
          );
          if (!selected || !work.changeRef)
            throw new Error("Selected AssetSet or captured change is missing");
          const applied = await materializeAssetSet({
            checkout: config.checkout,
            workRoot: join(root, "asset-materialization"),
            baseCommit: work.changeRef,
            item,
            set: selected,
            store: contentStore,
          });
          work.changeRef = applied.changeRef;
          work.treeSha = applied.treeSha;
        } else {
          const handle: ExecutionHandle =
            work.execution ??
            (await driver.start({
              item,
              baseSha: itemBase,
              attemptId: work.attempt,
            }));
          if (!work.execution) {
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
        );
        work.step = "deliver";
        save();
        commits.set(work.treeSha!, work.changeRef!);
        const published = await regular.publish({
          item,
          baseSha: itemBase,
          treeSha: work.treeSha!,
          branch: branchFor(item.id),
          lfs: Boolean(work.selectedAssetSet),
          baseBranch: previous
            ? branchFor(unit.items[index - 1]!.id)
            : defaultBranch,
        });
        work.pullRequest = published.pullRequest;
        work.status = "published";
        delete work.step;
        save();
      };
      const task = perform();
      active.set(item.id, task);
      try {
        await task;
      } finally {
        active.delete(item.id);
      }
      if (state.work[item.id]?.status === "waiting") return;
    }
    const layers: StackLayer[] = unit.items.map((item) => {
      const work = state.work[item.id]!;
      if (work.status !== "published" || !work.pullRequest || !work.changeRef)
        throw new Error(`Native delivery layer ${item.id} is incomplete`);
      return {
        pullRequest: work.pullRequest,
        branch: branchFor(item.id),
        headSha: work.changeRef,
      };
    });
    const pendingMerge = state.stackMerges?.[unit.id];
    const observations = await Promise.all(
      layers.map((layer) =>
        github.observe({
          number: layer.pullRequest,
          branch: layer.branch,
          headSha: layer.headSha,
        }),
      ),
    );
    const allMerged = observations.every(
      (observation) => observation.state === "merged",
    );
    if (!pendingMerge && !allMerged) {
      git(config.checkout, "fetch", "origin", defaultBranch);
      const observedBefore = git(config.checkout, "rev-parse", "FETCH_HEAD");
      if (observedBefore !== state.work[unit.items[0]!.id]!.baseSha)
        throw new Error(
          `Default branch moved before native unit ${unit.id}; operator direction required`,
        );
      for (const [index, observation] of observations.entries())
        if (observation.state !== "open" || observation.checks !== "passing")
          throw new Error(
            `Native PR #${layers[index]!.pullRequest} is not ready to merge`,
          );
    }
    let integratedSha: string;
    if (layers.length === 1) {
      const layer = layers[0]!;
      integratedSha = (
        await github.merge(
          {
            number: layer.pullRequest,
            branch: layer.branch,
            headSha: layer.headSha,
          },
          layer.headSha,
        )
      ).integratedSha;
    } else {
      state.stackNumbers ??= {};
      const stackNumber =
        state.stackNumbers[unit.id] ??
        native.ensureStack(layers, defaultBranch);
      if (
        state.stackNumbers[unit.id] &&
        state.stackNumbers[unit.id] !== stackNumber
      )
        throw new Error(
          "Native stack number changed; operator direction required",
        );
      state.stackNumbers[unit.id] = stackNumber;
      save();
      const pending = pendingMerge;
      if (
        pending &&
        (pending.topPullRequest !== layers.at(-1)!.pullRequest ||
          pending.expectedHeadSha !== layers.at(-1)!.headSha)
      )
        throw new Error(
          "Pending native merge identity changed; operator direction required",
        );
      integratedSha = await native.mergeStack(
        layers,
        defaultBranch,
        stackNumber,
        {
          resumeUuid: pending?.uuid,
          onPending: (uuid) => {
            state.stackMerges ??= {};
            state.stackMerges[unit.id] = {
              topPullRequest: layers.at(-1)!.pullRequest,
              expectedHeadSha: layers.at(-1)!.headSha,
              uuid,
            };
            save();
          },
          cancelled: args.cancelled,
        },
      );
    }
    git(config.checkout, "fetch", "origin", defaultBranch);
    const observedAfter = git(config.checkout, "rev-parse", "FETCH_HEAD");
    if (observedAfter !== integratedSha)
      throw new Error(
        `Default branch changed after native unit ${unit.id}; expected ${integratedSha}, observed ${observedAfter}`,
      );
    state.integratedSha = observedAfter;
    for (const item of unit.items) {
      const work = state.work[item.id]!;
      work.status = "done";
      work.completedAt = new Date().toISOString();
    }
    save();
    for (const item of unit.items)
      github.closeIssue(
        state.issueByItemId[item.id]!,
        `Completed by native delivery PR #${state.work[item.id]!.pullRequest}; integrated at ${observedAfter}.`,
      );
  }
}
