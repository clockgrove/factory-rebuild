# Local agent harnesses

Factory owns the Objective lifecycle. A local `AgentHarness` owns only one Work
Item attempt inside the exact worktree supplied by Factory. Codex is the default
harness; the source candidate also contains pinned Claude Agent SDK and GitHub
Copilot SDK adapters and a package-root registration seam for another adapter.

Planning and independent result review remain on the configured Codex SDK
models. Selecting Claude or GitHub Copilot changes only Work Item execution.

## Capability contract

Every harness must declare this exact capability record before composition:

```ts
{
  protocolVersion: 1,
  worktree: "factory-owned-read-write",
  head: "preserve",
  lifecycle: "restart-safe-durable-handle",
  publication: "controller-only",
  assetSets: true,
  authentication: "local-environment" | "adapter-owned" | "none"
}
```

Factory rejects a harness with incompatible capabilities. A conforming harness:

- operates only in the supplied Factory-owned worktree and leaves `HEAD`
  unchanged;
- does not commit, push, deploy, open or edit issues or pull requests, or
  receive the controller's GitHub publication credentials;
- returns a non-empty attempt identity plus JSON-safe durable handle data;
- supports restart-safe `observe`, `cancel`, and `collect` without creating a
  second ambiguous attempt;
- returns only normalized evidence and declared `AssetSet` candidates; and
- treats provider completion as an untrusted candidate result. Factory still
  checks owned paths and secrets, validates the exact result tree, performs
  independent acceptance review, publishes, and validates the integrated
  Objective.

The stable adapter identity and exact adapter-owned configuration are part of
Factory's configuration digest. Active local handles are also bound to that
identity. A missing registration, identity mismatch, configuration mismatch, or
mid-run configuration change stops instead of falling back to Codex or another
harness.

## Installed registration seam

An adapter package imports only the package root. It does not construct or
replace Factory's driver, scheduler, validator, GitHub gateway, delivery
strategy, planning models, or content store:

```ts
import {
  composeWithLocalHarness,
  type AgentHarness,
  type FactoryConfig,
} from "@clockgrove/factory";

const identity = "example/acme-agent@2";
const adapterConfig = {
  model: "acme-code-1",
  session: "new-per-attempt",
};

const harness: AgentHarness = {
  capabilities: {
    protocolVersion: 1,
    worktree: "factory-owned-read-write",
    head: "preserve",
    lifecycle: "restart-safe-durable-handle",
    publication: "controller-only",
    assetSets: true,
    authentication: "adapter-owned",
  },
  async start(request) {
    // Start once in request.worktree. Persist provider identity in `data`.
    return { identity: request.attemptId!, data: { providerTask: "..." } };
  },
  async observe(handle) {
    return { state: "running" };
  },
  async cancel(handle) {},
  async collect(handle) {
    return { evidence: { adapter: identity } };
  },
};

const config: FactoryConfig = {
  // ...ordinary Factory installation fields...
  execution: {
    kind: "local",
    concurrency: 1,
    harness: {
      kind: "registered",
      adapter: identity,
      config: adapterConfig,
    },
  },
};

const factory = composeWithLocalHarness(config, {
  identity,
  config: adapterConfig,
  harness,
});
await factory.runObjective(123);
```

The adapter owns the meaning and validation of its opaque JSON-safe config. A
behavior-changing adapter release should use a new stable identity. Factory
schema version 1 selects one harness for an Objective; mixed harnesses and
automatic fallback are intentionally unsupported.

## Built-in adapter matrix

| Harness             | Package and license                                                                                                                                                                                                                | Local runtime                                     | Explicit Factory boundary                                                                                                                                                                                          | Authentication                                                                                                                                                                       |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex SDK (default) | bundled `@openai/codex-sdk@0.156.0`; Apache-2.0                                                                                                                                                                                    | local SDK worker                                  | explicit model/reasoning, workspace-write, approval prompts disabled                                                                                                                                               | existing Codex local login/profile                                                                                                                                                   |
| Claude Agent SDK    | optional [`@anthropic-ai/claude-agent-sdk@0.3.281`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk); [Anthropic proprietary license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md) | local SDK worker process                          | exact model/effort, tool and allowed-tool lists, permission mode, setting sources, turn limit; MCP, plugins, skills, subagents, and session persistence disabled unless the adapter shape is deliberately extended | standard Claude local profile or named Claude/Anthropic auth environment                                                                                                             |
| GitHub Copilot SDK  | optional [`@github/copilot-sdk@1.0.13`](https://www.npmjs.com/package/@github/copilot-sdk); MIT                                                                                                                                    | bundled local Copilot CLI/runtime in `empty` mode | exact model/reasoning/timeout, explicit file tools and read/write permissions; shell, task, web, GitHub, MCP, memory, skills, plugins, host-Git operations, remote sessions, and config discovery disabled         | [stored Copilot CLI OAuth/keychain identity or documented `gh` fallback](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate) or named Copilot auth environment |
| Registered adapter  | adopter package                                                                                                                                                                                                                    | adapter-defined local process                     | exact capability declaration, stable identity, opaque JSON-safe config                                                                                                                                             | `local-environment`, `adapter-owned`, or `none`, as declared                                                                                                                         |

The two optional SDK packages are declared as exact optional package
dependencies. A normal online npm installation installs them. An installation
using `--omit=optional` can still use Codex and the generic registered seam, but
cannot select the Claude or GitHub Copilot built-in adapter.

All three built-in harnesses reuse the developer's local authentication. Factory
does not add tokens to its configuration file. For example, an existing `codex`
CLI login is visible to the Codex SDK worker, an existing Claude profile is
visible to the Claude worker, and the Copilot SDK is started with
`useLoggedInUser: true` against the developer's local Copilot state. The worker
environment excludes controller publication variables such as `GH_TOKEN` and
`GITHUB_TOKEN`; Copilot's documented local `gh` configuration fallback remains
available without exposing a GitHub tool to the agent.

If a profile is missing or expired, the attempt fails durably with a specific
request to authenticate in the developer environment:

```sh
codex login
claude auth login
copilot auth login
```

After login, the operator explicitly starts a fresh unpublished attempt:

```sh
factory retry --objective ISSUE_NUMBER --item WORK_ITEM_ID
factory run --objective ISSUE_NUMBER
```

Factory never opens an interactive credential prompt inside a detached worker,
stores the resulting credential in run state, or silently changes provider.

## CLI selection

Codex remains the default when `--harness` is omitted. The current source
candidate can install either optional adapter explicitly:

```sh
factory install \
  --repository OWNER/REPO --checkout /absolute/target --concurrency 1 \
  --harness claude-agent-sdk \
  --worker-model CLAUDE_MODEL --worker-reasoning medium \
  --claude-max-turns 12

factory install \
  --repository OWNER/REPO --checkout /absolute/target --concurrency 1 \
  --harness github-copilot-sdk \
  --worker-model COPILOT_MODEL --worker-reasoning medium \
  --copilot-timeout-seconds 900
```

Claude defaults to `Read`, `Edit`, `Write`, `Glob`, and `Grep`. GitHub Copilot
defaults to `view`, `create`, `edit`, `grep`, and `glob`. Repeated
`--claude-tool`, `--claude-allow-tool`, and `--copilot-tool` flags make those
sets explicit. Claude setting sources are empty by default; each allowed source
requires a repeated `--claude-setting-source` flag. Provider-specific fields do
not cross adapters.

## Security boundary and acceptance

These are local processes running as the developer's OS account. Worktree path
checks, SDK permission callbacks, filtered environments, and disabled extension
surfaces reduce accidental authority; they are not an OS sandbox for hostile
repository code. Source-authorized validation commands also run locally under
operator authority. Managed agents, remote Copilot sessions, sandbox execution,
Daytona, dynamic provider installation, and a provider marketplace are outside
this seam.

Credential-free CI packs Factory, installs it while omitting optional packages,
imports only `@clockgrove/factory`, injects a scripted non-Codex harness, and
runs a complete one-item path through the production local driver, exact-tree
validation, regular delivery, and final validation. Real provider acceptance is
separate: Codex, Claude, and GitHub Copilot must run the same bounded disposable
target from the exact packed artifact. Those live calls require explicit
operator authorization and available provider access; deterministic CI does not
claim that proof.
