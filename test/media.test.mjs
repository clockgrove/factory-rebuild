import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import {
  captureAssetSets,
  materializeAssetSet,
  parseProducedAssetSets,
} from "../dist/media.js";

test("harness AssetSet manifest rejects missing member bindings", () => {
  assert.throws(() => parseProducedAssetSets({ sets: [] }), /sets array/);
  assert.throws(
    () =>
      parseProducedAssetSets([
        {
          id: "bad",
          members: [{ role: "image" }],
          provenance: {
            source: "fixture",
            rights: "fixture",
            visibility: "repository",
            lineage: [],
          },
        },
      ]),
    /binding is incomplete/,
  );
});

function git(path, ...args) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8",
  }).trim();
}

test("a complete selected AssetSet is retained by digest and committed through the target LFS rule", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-media-test-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    git(checkout, "init", "-b", "main");
    writeFileSync(
      join(checkout, ".gitattributes"),
      "approved/*.png filter=lfs diff=lfs merge=lfs -text\n",
    );
    git(checkout, "add", ".gitattributes");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "LFS policy",
    );
    const base = git(checkout, "rev-parse", "HEAD");
    const staging = join(root, "staging");
    const item = {
      id: "media",
      ownedPaths: ["approved/selected.png", "approved/selected.json"],
      expectedOutputRoles: ["image", "metadata"],
      requiredLfsRoles: ["image"],
    };
    const source = readFileSync(
      new URL(
        "./fixtures/disposable-target/assets/source.png",
        import.meta.url,
      ),
    );
    const sets = ["first", "second"].map((id) => {
      const directory = join(staging, ".factory-media", id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "image.png"), source);
      writeFileSync(join(directory, "metadata.json"), JSON.stringify({ id }));
      return {
        id,
        members: [
          {
            role: "image",
            path: `.factory-media/${id}/image.png`,
            mediaType: "image/png",
            destination: "approved/selected.png",
          },
          {
            role: "metadata",
            path: `.factory-media/${id}/metadata.json`,
            mediaType: "application/json",
            destination: "approved/selected.json",
          },
        ],
        provenance: {
          source: "assets/source.png",
          rights: "fixture authored for this test",
          visibility: "repository",
          lineage: ["assets/source.png"],
        },
      };
    });
    const store = new LocalContentStore(join(root, "content"));
    const captured = await captureAssetSets(store, staging, item, sets, {
      harness: "scripted",
    });
    assert.equal(captured.length, 2);
    assert.equal(
      captured[0].members[0].ref.digest,
      createHash("sha256").update(source).digest("hex"),
    );
    const selected = await materializeAssetSet({
      checkout,
      workRoot: join(root, "worktrees"),
      baseCommit: base,
      item,
      set: captured[1],
      store,
    });
    const pointer = git(
      checkout,
      "show",
      `${selected.changeRef}:approved/selected.png`,
    );
    assert.match(pointer, /version https:\/\/git-lfs.github.com\/spec\/v1/);
    assert.match(pointer, new RegExp(captured[1].members[0].ref.digest));
    assert.equal(
      git(checkout, "show", `${selected.changeRef}:approved/selected.json`),
      '{"id":"second"}',
    );
    assert.notEqual(selected.changeRef, base);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an image role follows the target's ordinary Git policy when LFS is not required", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-ordinary-image-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    git(checkout, "init", "-b", "main");
    writeFileSync(join(checkout, "README.md"), "ordinary image repository\n");
    git(checkout, "add", "README.md");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "baseline",
    );
    const source = join(root, "source.png");
    const bytes = readFileSync(
      new URL(
        "./fixtures/disposable-target/assets/source.png",
        import.meta.url,
      ),
    );
    writeFileSync(source, bytes);
    const store = new LocalContentStore(join(root, "content"));
    const ref = await store.importFile(source, {
      mediaType: "image/png",
      visibility: "repository",
    });
    const item = {
      id: "ordinary",
      ownedPaths: ["images/output.png"],
      expectedOutputRoles: ["image"],
      requiredLfsRoles: [],
    };
    const set = {
      id: "only",
      members: [{ role: "image", ref, destination: "images/output.png" }],
      provenance: {
        source: "source.png",
        rights: "fixture",
        visibility: "repository",
        lineage: ["source.png"],
      },
      evidence: { harness: "scripted" },
    };
    const result = await materializeAssetSet({
      checkout,
      workRoot: join(root, "worktrees"),
      baseCommit: git(checkout, "rev-parse", "HEAD"),
      item,
      set,
      store,
    });
    const committed = execFileSync("git", [
      "-C",
      checkout,
      "show",
      `${result.changeRef}:images/output.png`,
    ]);
    assert.deepEqual(committed, bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
