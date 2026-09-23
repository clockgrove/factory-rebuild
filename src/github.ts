import type {
  GitHubGateway,
  GraphProjection,
  ProjectedGraph,
  PullRequestPublication,
  PullRequestIdentity,
  PullRequestObservation,
  MergeResult,
} from "./contracts.js";
import { command } from "./process.js";

export class RealGitHubGateway implements GitHubGateway {
  constructor(readonly repository: string) {}

  defaultBranch(): string {
    const result = JSON.parse(
      command("gh", [
        "repo",
        "view",
        this.repository,
        "--json",
        "defaultBranchRef",
      ]),
    ) as { defaultBranchRef: { name: string } };
    if (!result.defaultBranchRef?.name)
      throw new Error("Repository has no default branch");
    return result.defaultBranchRef.name;
  }

  objective(number: number): { body: string; title: string } {
    return JSON.parse(
      command("gh", [
        "issue",
        "view",
        String(number),
        "-R",
        this.repository,
        "--json",
        "body,title",
      ]),
    ) as { body: string; title: string };
  }

  closeIssue(number: number, comment: string): void {
    command("gh", [
      "issue",
      "close",
      String(number),
      "-R",
      this.repository,
      "--reason",
      "completed",
      "--comment",
      comment,
    ]);
  }

  async projectGraph(request: GraphProjection): Promise<ProjectedGraph> {
    const issueByItemId: Record<string, number> = {};
    for (const item of request.graph.items) {
      const marker = `<!-- factory:objective=${request.objectiveIssue};item=${item.id} -->`;
      const existing = JSON.parse(
        command("gh", [
          "issue",
          "list",
          "-R",
          this.repository,
          "--state",
          "all",
          "--search",
          `"${marker}" in:body`,
          "--json",
          "number,body",
        ]),
      ) as { number: number; body: string }[];
      const found = existing.find((issue) => issue.body.includes(marker));
      if (found) {
        issueByItemId[item.id] = found.number;
        continue;
      }
      const body = `${marker}\n\n## Goal\n${item.goal}\n\n## Acceptance\n${item.acceptance.map((a) => `- ${a}`).join("\n")}\n\n## Sources\n${item.citations.map((c) => `- ${c.path}${c.heading ? ` — ${c.heading}` : ""}`).join("\n")}\n\n## Owned paths\n${item.ownedPaths.map((p) => `- ${p}`).join("\n")}\n\n${item.brief}`;
      const url = command("gh", [
        "issue",
        "create",
        "-R",
        this.repository,
        "--title",
        item.title,
        "--body",
        body,
      ]);
      const number = Number(url.match(/\/(\d+)$/)?.[1]);
      if (!number)
        throw new Error(`Cannot parse created Work Item issue: ${url}`);
      issueByItemId[item.id] = number;
    }
    return { issueByItemId };
  }

  async publish(request: PullRequestPublication): Promise<PullRequestIdentity> {
    const url = command("gh", [
      "pr",
      "create",
      "-R",
      this.repository,
      "--head",
      request.branch,
      "--base",
      request.base,
      "--title",
      request.title,
      "--body",
      request.body,
    ]);
    const number = Number(url.match(/\/(\d+)$/)?.[1]);
    if (!number) throw new Error(`Cannot parse created PR: ${url}`);
    const detail = JSON.parse(
      command("gh", [
        "pr",
        "view",
        String(number),
        "-R",
        this.repository,
        "--json",
        "headRefOid",
      ]),
    ) as { headRefOid: string };
    return { number, branch: request.branch, headSha: detail.headRefOid };
  }

  async observe(
    identity: PullRequestIdentity,
  ): Promise<PullRequestObservation> {
    const detail = JSON.parse(
      command("gh", [
        "pr",
        "view",
        String(identity.number),
        "-R",
        this.repository,
        "--json",
        "state,statusCheckRollup",
      ]),
    ) as {
      state: string;
      statusCheckRollup: { conclusion?: string; status?: string }[];
    };
    const checks = detail.statusCheckRollup ?? [];
    return {
      state:
        detail.state === "MERGED"
          ? "merged"
          : detail.state === "CLOSED"
            ? "closed"
            : "open",
      checks: checks.some((c) => c.conclusion === "FAILURE")
        ? "failing"
        : checks.some((c) => c.status !== "COMPLETED")
          ? "pending"
          : "passing",
    };
  }

  async merge(
    identity: PullRequestIdentity,
    expectedHead: string,
  ): Promise<MergeResult> {
    command("gh", [
      "pr",
      "merge",
      String(identity.number),
      "-R",
      this.repository,
      "--merge",
      "--match-head-commit",
      expectedHead,
    ]);
    const detail = JSON.parse(
      command("gh", [
        "pr",
        "view",
        String(identity.number),
        "-R",
        this.repository,
        "--json",
        "mergeCommit,state",
      ]),
    ) as { mergeCommit: { oid: string } | null; state: string };
    if (detail.state !== "MERGED" || !detail.mergeCommit)
      throw new Error("PR merge did not produce an integrated commit");
    return { integratedSha: detail.mergeCommit.oid };
  }
}
