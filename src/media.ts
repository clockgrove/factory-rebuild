import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  CapturedAssetSet,
  ContentRef,
  ProducedAssetSet,
  SourceAssetBinding,
  WorkItem,
} from "./contracts.js";
import { LocalContentStore } from "./content/local.js";
import { command, pinnedGit } from "./process.js";

function safeRelative(path: string, staging = false): boolean {
  return (
    !!path &&
    !isAbsolute(path) &&
    !path
      .split(/[\\/]/)
      .some((part) => part === ".." || part === "." || part === "") &&
    !path.includes("\\") &&
    path !== ".git" &&
    !path.startsWith(".git/") &&
    path !== ".factory-assets.json" &&
    path !== ".factory-media" &&
    (staging || !path.startsWith(".factory-media/"))
  );
}

function owned(path: string, scopes: string[]): boolean {
  return scopes.some((scope) =>
    scope.endsWith("/") ? path.startsWith(scope) : path === scope,
  );
}

/** One ingress check for the worker manifest and controller collection. */
export function parseProducedAssetSets(value: unknown): ProducedAssetSet[] {
  if (!Array.isArray(value))
    throw new Error("AssetSet manifest must contain a sets array");
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("AssetSet entry must be an object");
    const set = raw as Record<string, unknown>;
    if (
      typeof set.id !== "string" ||
      !Array.isArray(set.members) ||
      !set.members.length
    )
      throw new Error("AssetSet entry needs an ID and members");
    const provenance = set.provenance as Record<string, unknown> | undefined;
    if (
      !provenance ||
      typeof provenance.source !== "string" ||
      typeof provenance.rights !== "string" ||
      !["private", "repository"].includes(String(provenance.visibility)) ||
      !Array.isArray(provenance.lineage) ||
      !provenance.lineage.every((part) => typeof part === "string")
    )
      throw new Error(`AssetSet ${set.id} provenance is invalid`);
    const declaredRoles = new Set<string>();
    for (const rawMember of set.members) {
      if (
        !rawMember ||
        typeof rawMember !== "object" ||
        Array.isArray(rawMember)
      )
        throw new Error(`AssetSet ${set.id} member is invalid`);
      const member = rawMember as Record<string, unknown>;
      if (
        ["role", "path", "mediaType", "destination"].some(
          (key) => typeof member[key] !== "string",
        )
      )
        throw new Error(`AssetSet ${set.id} member binding is incomplete`);
      declaredRoles.add(member.role as string);
      if (member.formatMetadata !== undefined) {
        const metadata = member.formatMetadata;
        if (
          !metadata ||
          typeof metadata !== "object" ||
          Array.isArray(metadata)
        )
          throw new Error(`AssetSet ${set.id} format metadata is invalid`);
        const detail = metadata as Record<string, unknown>;
        if (
          typeof detail.source !== "string" ||
          !detail.source ||
          !detail.values ||
          typeof detail.values !== "object" ||
          Array.isArray(detail.values)
        )
          throw new Error(`AssetSet ${set.id} format metadata is invalid`);
      }
    }
    if (set.relationships !== undefined) {
      if (
        !Array.isArray(set.relationships) ||
        !set.relationships.every(
          (edge) =>
            edge &&
            typeof edge === "object" &&
            typeof edge.from === "string" &&
            !!edge.from &&
            typeof edge.toRole === "string" &&
            declaredRoles.has(edge.toRole) &&
            typeof edge.kind === "string" &&
            !!edge.kind,
        )
      )
        throw new Error(`AssetSet ${set.id} relationships are invalid`);
    }
  }
  return value as ProducedAssetSet[];
}

export async function importSourceAssets(
  store: LocalContentStore,
  worktree: string,
  item: WorkItem,
): Promise<{ binding: SourceAssetBinding; ref: ContentRef }[]> {
  const result: { binding: SourceAssetBinding; ref: ContentRef }[] = [];
  for (const source of item.sourceAssets ?? []) {
    const binding: SourceAssetBinding =
      typeof source === "string"
        ? {
            path: source,
            role: "source",
            mediaType: "application/octet-stream",
            visibility: "repository",
          }
        : source;
    const { path } = binding;
    if (!safeRelative(path))
      throw new Error(`Invalid source asset path: ${path}`);
    const absolute = join(worktree, path);
    if (!existsSync(absolute))
      throw new Error(`Source asset does not exist: ${path}`);
    const ref = await store.importFile(absolute, {
      mediaType: binding.mediaType,
    });
    result.push({ binding, ref });
  }
  return result;
}

export async function captureAssetSets(
  store: LocalContentStore,
  worktree: string,
  item: WorkItem,
  sets: ProducedAssetSet[],
  evidence: unknown,
  inputs: { binding: SourceAssetBinding; ref: ContentRef }[] = [],
): Promise<CapturedAssetSet[]> {
  parseProducedAssetSets(sets);
  if (new Set(sets.map((set) => set.id)).size !== sets.length)
    throw new Error("Produced AssetSet identifiers must be unique");
  if (sets.length && !evidence)
    throw new Error("Produced AssetSets require harness evidence");
  if (
    sets.length &&
    (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
  )
    throw new Error("Produced AssetSets require structured harness evidence");
  const evidenceObject = (
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? evidence
      : {}
  ) as Record<string, unknown>;
  const harnessIdentity = String(
    evidenceObject.threadId ?? evidenceObject.harness ?? "",
  );
  if (sets.length && !harnessIdentity)
    throw new Error("Produced AssetSets require a harness identity");
  const evidenceRef = {
    harnessIdentity,
    resultDigest: createHash("sha256")
      .update(JSON.stringify(evidence ?? {}))
      .digest("hex"),
  };
  const mediaRoot = join(worktree, ".factory-media");
  if (
    sets.length &&
    (!existsSync(mediaRoot) || realpathSync(mediaRoot) !== resolve(mediaRoot))
  )
    throw new Error("Produced media root is missing or redirected");
  const captured: CapturedAssetSet[] = [];
  for (const set of sets) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(set.id) || !set.members.length)
      throw new Error(
        "Produced AssetSet has an invalid identity or no members",
      );
    const provenance = set.provenance;
    if (
      !provenance ||
      !provenance.source ||
      !provenance.rights ||
      !["private", "repository"].includes(provenance.visibility) ||
      !Array.isArray(provenance.lineage)
    )
      throw new Error(
        "Produced AssetSet lacks provenance, rights, visibility, or lineage",
      );
    const roles = new Set<string>();
    const destinations = new Set<string>();
    const members: CapturedAssetSet["members"] = [];
    for (const member of set.members) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(member.role) ||
        roles.has(member.role) ||
        !member.destination ||
        !safeRelative(member.destination) ||
        !owned(member.destination, item.ownedPaths) ||
        destinations.has(member.destination)
      )
        throw new Error(
          "Produced AssetSet has duplicate or unowned member bindings",
        );
      roles.add(member.role);
      destinations.add(member.destination);
      if (
        !safeRelative(member.path, true) ||
        !member.path.startsWith(".factory-media/")
      )
        throw new Error("Produced asset must be inside .factory-media");
      const path = resolve(worktree, member.path);
      if (
        !existsSync(path) ||
        !lstatSync(path).isFile() ||
        !realpathSync(path).startsWith(`${realpathSync(mediaRoot)}${sep}`)
      )
        throw new Error(
          "Produced asset path is missing or escapes the media root",
        );
      const ref = await store.importFile(path, {
        mediaType: member.mediaType,
      });
      members.push({
        role: member.role,
        ref,
        destination: member.destination,
        ...(member.formatMetadata && { formatMetadata: member.formatMetadata }),
      });
    }
    for (const role of item.expectedOutputRoles ?? [])
      if (!roles.has(role))
        throw new Error(`AssetSet ${set.id} lacks expected role ${role}`);
    captured.push({
      id: set.id,
      ...(inputs.length && { inputs }),
      members,
      ...(set.relationships && { relationships: set.relationships }),
      provenance,
      evidence: evidenceRef,
    });
  }
  rmSync(mediaRoot, { recursive: true, force: true });
  if (
    new Set(
      captured.map((set) =>
        JSON.stringify(
          set.members.map((member) => [member.role, member.ref.digest]),
        ),
      ),
    ).size !== captured.length
  )
    throw new Error("Candidate AssetSets must have distinct content");
  return captured;
}

export async function materializeAssetSet(args: {
  checkout: string;
  workRoot: string;
  baseCommit: string;
  item: WorkItem;
  set: CapturedAssetSet;
  store: LocalContentStore;
}): Promise<{ changeRef: string; treeSha: string }> {
  const worktree = join(args.workRoot, `selected-${randomUUID()}`);
  mkdirSync(args.workRoot, { recursive: true });
  pinnedGit(
    args.checkout,
    "worktree",
    "add",
    "--detach",
    worktree,
    args.baseCommit,
  );
  try {
    command("git", ["-C", worktree, "lfs", "install", "--local"]);
    const destinations = new Set<string>();
    for (const member of args.set.members) {
      if (
        !safeRelative(member.destination) ||
        !owned(member.destination, args.item.ownedPaths) ||
        destinations.has(member.destination)
      )
        throw new Error("Selected AssetSet destination is invalid or unowned");
      destinations.add(member.destination);
      const destination = join(worktree, member.destination);
      if (existsSync(destination))
        throw new Error(`Selected asset would overwrite ${member.destination}`);
      await args.store.materialize(member.ref, destination);
      const filter = pinnedGit(
        worktree,
        "check-attr",
        "filter",
        "--",
        member.destination,
      );
      if (
        args.item.requiredLfsRoles?.includes(member.role) &&
        !filter.endsWith(": lfs")
      )
        throw new Error(
          `Repository LFS policy does not cover ${member.destination}`,
        );
    }
    pinnedGit(worktree, "add", "--", ...[...destinations]);
    pinnedGit(
      worktree,
      "-c",
      "user.name=Factory",
      "-c",
      "user.email=factory@users.noreply.github.com",
      "commit",
      "-m",
      `Factory: selected ${args.set.id} assets`,
    );
    const changeRef = pinnedGit(worktree, "rev-parse", "HEAD");
    for (const member of args.set.members) {
      const filter = pinnedGit(
        worktree,
        "check-attr",
        "filter",
        "--",
        member.destination,
      );
      if (!filter.endsWith(": lfs")) continue;
      const pointer = pinnedGit(
        worktree,
        "show",
        `${changeRef}:${member.destination}`,
      );
      const expected = `oid sha256:${member.ref.digest}\nsize ${member.ref.bytes}`;
      if (
        !pointer.startsWith("version https://git-lfs.github.com/spec/v1\n") ||
        !pointer.includes(expected)
      )
        throw new Error(
          `LFS pointer for ${member.destination} differs from selected bytes`,
        );
    }
    return {
      changeRef,
      treeSha: pinnedGit(worktree, "rev-parse", "HEAD^{tree}"),
    };
  } finally {
    try {
      pinnedGit(args.checkout, "worktree", "remove", "--force", worktree);
    } catch {
      rmSync(worktree, { recursive: true, force: true });
    }
  }
}

export function assetSelectionDigest(set: CapturedAssetSet): string {
  return createHash("sha256").update(JSON.stringify(set)).digest("hex");
}

export function verifyHydratedAssets(args: {
  checkout: string;
  workRoot: string;
  integratedSha: string;
  sets: CapturedAssetSet[];
}): void {
  if (!args.sets.length) return;
  mkdirSync(args.workRoot, { recursive: true });
  const clone = join(args.workRoot, `fresh-${randomUUID()}`);
  const remote = pinnedGit(args.checkout, "remote", "get-url", "origin");
  try {
    command("git", ["clone", "--no-checkout", remote, clone]);
    command("git", ["-C", clone, "lfs", "install", "--local"]);
    command("git", ["-C", clone, "checkout", "--detach", args.integratedSha]);
    command("git", ["-C", clone, "lfs", "pull"]);
    if (pinnedGit(clone, "rev-parse", "HEAD") !== args.integratedSha)
      throw new Error("Fresh clone resolved a different integrated commit");
    for (const set of args.sets)
      for (const member of set.members) {
        const path = join(clone, member.destination);
        if (!existsSync(path) || !lstatSync(path).isFile())
          throw new Error(`Hydrated asset is missing: ${member.destination}`);
        const fd = openSync(path, "r");
        const hash = createHash("sha256");
        let bytes = 0;
        try {
          const expectedBytes = fstatSync(fd).size;
          const chunk = Buffer.allocUnsafe(64 * 1024);
          for (;;) {
            const count = readSync(fd, chunk, 0, chunk.length, null);
            if (!count) break;
            hash.update(chunk.subarray(0, count));
            bytes += count;
          }
          if (bytes !== expectedBytes)
            throw new Error("Hydrated file changed during verification");
        } finally {
          closeSync(fd);
        }
        if (
          bytes !== member.ref.bytes ||
          hash.digest("hex") !== member.ref.digest
        )
          throw new Error(
            `Hydrated asset differs from selected bytes: ${member.destination}`,
          );
      }
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}
