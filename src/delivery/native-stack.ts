import { command } from "../process.js";

const version = "2026-03-10";

type Pull = {
  number: number;
  state: string;
  merged?: boolean;
  merged_at?: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  merge_commit_sha?: string | null;
};
type Stack = {
  number: number;
  base: { ref: string };
  pull_requests: Pull[];
};

export interface StackLayer {
  pullRequest: number;
  branch: string;
  headSha: string;
}

export class NativeStackDelivery {
  constructor(private repository: string) {}

  private api<T>(route: string, method = "GET", body?: unknown): T {
    const args = [
      "api",
      "-H",
      `X-GitHub-Api-Version: ${version}`,
      "-X",
      method,
      route,
    ];
    if (body !== undefined) args.push("--input", "-");
    return JSON.parse(
      command(
        "gh",
        args,
        undefined,
        undefined,
        body === undefined ? undefined : JSON.stringify(body),
      ),
    ) as T;
  }

  private pull(number: number): Pull {
    return this.api<Pull>(`repos/${this.repository}/pulls/${number}`);
  }

  private mergedSha(number: number): string {
    const detail = JSON.parse(
      command("gh", [
        "pr",
        "view",
        String(number),
        "-R",
        this.repository,
        "--json",
        "state,mergeCommit",
      ]),
    ) as { state: string; mergeCommit: { oid: string } | null };
    if (detail.state !== "MERGED" || !detail.mergeCommit?.oid)
      throw new Error(
        `Native stack PR #${number} has no integrated commit yet`,
      );
    return detail.mergeCommit.oid;
  }

  private assertLayers(layers: StackLayer[], baseBranch: string): void {
    for (const [index, layer] of layers.entries()) {
      const observed = this.pull(layer.pullRequest);
      const expectedBase = index ? layers[index - 1]!.branch : baseBranch;
      if (
        observed.head.ref !== layer.branch ||
        observed.head.sha !== layer.headSha ||
        observed.base.ref !== expectedBase ||
        observed.state !== "open"
      ) {
        throw new Error(
          `Native stack PR #${layer.pullRequest} changed head, base, or state; operator direction required`,
        );
      }
    }
  }

  ensureStack(layers: StackLayer[], baseBranch: string): number {
    if (layers.length < 2)
      throw new Error("Native stack requires two or more PRs");
    this.assertLayers(layers, baseBranch);
    const numbers = layers.map((layer) => layer.pullRequest);
    const existing = this.api<Stack[]>(
      `repos/${this.repository}/stacks?pull_request=${numbers[0]}`,
    );
    if (existing.length) {
      const stack = existing[0]!;
      if (
        existing.length !== 1 ||
        stack.base.ref !== baseBranch ||
        JSON.stringify(stack.pull_requests.map((pull) => pull.number)) !==
          JSON.stringify(numbers)
      )
        throw new Error(
          "Native stack topology changed; operator direction required",
        );
      return stack.number;
    }
    const created = this.api<Stack>(`repos/${this.repository}/stacks`, "POST", {
      pull_requests: numbers,
    });
    if (
      created.base.ref !== baseBranch ||
      JSON.stringify(created.pull_requests.map((pull) => pull.number)) !==
        JSON.stringify(numbers)
    )
      throw new Error("GitHub created an unexpected native stack topology");
    return created.number;
  }

  async mergeStack(
    layers: StackLayer[],
    baseBranch: string,
    expectedStack: number,
    options: {
      resumeUuid?: string;
      onPending: (uuid: string) => void;
      cancelled: () => boolean;
    },
  ): Promise<string> {
    const already = layers.map((layer) => this.pull(layer.pullRequest));
    if (
      already.every(
        (pull) =>
          pull.state === "closed" && pull.merged === true && pull.merged_at,
      )
    ) {
      for (const [index, pull] of already.entries())
        if (
          pull.head.ref !== layers[index]!.branch ||
          pull.head.sha !== layers[index]!.headSha
        )
          throw new Error(
            "Merged native stack head changed; operator direction required",
          );
      const merged = layers.map((layer) => this.mergedSha(layer.pullRequest));
      if (new Set(merged).size !== 1)
        throw new Error("Native stack layers have different merge commits");
      return merged[0]!;
    }
    if (
      !options.resumeUuid &&
      this.ensureStack(layers, baseBranch) !== expectedStack
    )
      throw new Error("Native stack identity changed before merge");
    const top = layers.at(-1)!;
    type AsyncResult = {
      status: string;
      details: { uuid?: string; sha?: string; message?: string };
    };
    let uuid = options.resumeUuid;
    let observed: AsyncResult;
    if (uuid) {
      observed = this.api(
        `repos/${this.repository}/pulls/${top.pullRequest}/merge-async/${uuid}`,
      );
    } else {
      observed = this.api<AsyncResult>(
        `repos/${this.repository}/pulls/${top.pullRequest}/merge-async`,
        "PUT",
        {
          sha: top.headSha,
          merge_method: "merge",
          merge_action: "default",
        },
      );
      if (observed.status === "pending" && observed.details.uuid) {
        uuid = observed.details.uuid;
        options.onPending(uuid);
      }
    }
    while (observed.status === "pending" || observed.status === "queued") {
      if (options.cancelled())
        throw new Error("Objective cancelled during native merge observation");
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (uuid)
        observed = this.api(
          `repos/${this.repository}/pulls/${top.pullRequest}/merge-async/${uuid}`,
        );
      else {
        const pull = this.pull(top.pullRequest);
        if (pull.state === "closed" && pull.merged === true)
          observed = {
            status: "merged",
            details: { sha: this.mergedSha(top.pullRequest) },
          };
      }
    }
    if (observed.status !== "merged" || !observed.details.sha)
      throw new Error(
        `Native stack merge failed: ${observed.details.message ?? observed.status}`,
      );
    for (;;) {
      if (options.cancelled())
        throw new Error("Objective cancelled during native merge observation");
      const pulls = layers.map((layer) => this.pull(layer.pullRequest));
      if (
        pulls.every(
          (pull) =>
            pull.state === "closed" && pull.merged === true && pull.merged_at,
        )
      )
        break;
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    const merged = layers.map((layer) => this.mergedSha(layer.pullRequest));
    if (new Set(merged).size !== 1 || merged[0] !== observed.details.sha)
      throw new Error(
        "Native stack merge commit differs from the async result",
      );
    return observed.details.sha;
  }
}
