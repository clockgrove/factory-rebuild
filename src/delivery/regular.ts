import type {
  DeliveryRequest,
  DeliveryResult,
  DeliveryObservation,
  DeliveryStrategy,
  MergeResult,
} from "../contracts.js";
import { RealGitHubGateway } from "../github.js";
import { git } from "../process.js";

export class RegularDelivery implements DeliveryStrategy {
  constructor(
    private checkout: string,
    private github: RealGitHubGateway,
    private commitByTree: Map<string, string>,
  ) {}

  async publish(request: DeliveryRequest): Promise<DeliveryResult> {
    const commit = this.commitByTree.get(request.treeSha);
    if (!commit) throw new Error("Validated commit is missing for result tree");
    const base = request.baseBranch ?? this.github.defaultBranch();
    const existing = this.github.findOpenPullRequest(
      request.branch,
      base,
      commit,
    );
    if (existing)
      return {
        branch: existing.branch,
        pullRequest: existing.number,
        headSha: existing.headSha,
      };
    git(
      this.checkout,
      "push",
      "origin",
      `${commit}:refs/heads/${request.branch}`,
    );
    const pr = await this.github.publish({
      branch: request.branch,
      base,
      treeSha: request.treeSha,
      title: request.item.title,
      body: `Implements Work Item ${request.item.id}.\n\nValidated tree: ${request.treeSha}`,
    });
    if (pr.headSha !== commit)
      throw new Error("Published PR head differs from validated commit");
    return {
      branch: request.branch,
      pullRequest: pr.number,
      headSha: pr.headSha,
    };
  }

  async observe(result: DeliveryResult): Promise<DeliveryObservation> {
    return this.github.observe({
      number: result.pullRequest,
      branch: result.branch,
      headSha: result.headSha,
    });
  }

  async merge(result: DeliveryResult): Promise<MergeResult> {
    const observation = await this.observe(result);
    if (observation.state !== "open" || observation.checks !== "passing") {
      throw new Error(
        `PR is not mergeable: ${observation.state}, checks ${observation.checks}`,
      );
    }
    return this.github.merge(
      {
        number: result.pullRequest,
        branch: result.branch,
        headSha: result.headSha,
      },
      result.headSha,
    );
  }
}
