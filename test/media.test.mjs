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
  importSourceAssets,
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

test("opaque 3D source and multi-file output retain bindings, relationships, metadata, and target LFS policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-opaque-media-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    writeFileSync(
      join(checkout, ".gitattributes"),
      "models/*.blend filter=lfs diff=lfs merge=lfs -text\n",
    );
    git(checkout, "init", "-b", "main");
    git(checkout, "add", ".gitattributes");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "policy",
    );
    const staging = join(root, "staging");
    mkdirSync(join(staging, "inputs"), { recursive: true });
    const sourceBytes = Buffer.from([0, 255, 81, 0, 17, 204]);
    writeFileSync(join(staging, "inputs", "source.blend"), sourceBytes);
    const binding = {
      path: "inputs/source.blend",
      role: "mesh-source",
      mediaType: "application/x-blender",
      visibility: "repository",
    };
    const item = {
      id: "mesh",
      sourceAssets: [binding],
      ownedPaths: ["models/output.blend", "models/output.json"],
      expectedOutputRoles: ["model", "metadata"],
      requiredLfsRoles: ["model"],
    };
    const store = new LocalContentStore(join(root, "content"));
    const imported = await importSourceAssets(store, staging, item);
    assert.deepEqual(imported[0].binding, binding);
    assert.equal(imported[0].ref.mediaType, "application/x-blender");
    assert.equal(
      imported[0].ref.digest,
      createHash("sha256").update(sourceBytes).digest("hex"),
    );
    const directory = join(staging, ".factory-media", "candidate-a");
    mkdirSync(directory, { recursive: true });
    const outputBytes = Buffer.from([66, 76, 69, 78, 68, 69, 82, 0, 255, 12]);
    writeFileSync(join(directory, "model.blend"), outputBytes);
    writeFileSync(
      join(directory, "details.json"),
      '{"source":"inputs/source.blend"}',
    );
    const sets = [
      {
        id: "candidate-a",
        members: [
          {
            role: "model",
            path: ".factory-media/candidate-a/model.blend",
            mediaType: "application/x-blender",
            destination: "models/output.blend",
            formatMetadata: {
              source: "fixture-tool",
              values: { unit: "meter" },
            },
          },
          {
            role: "metadata",
            path: ".factory-media/candidate-a/details.json",
            mediaType: "application/json",
            destination: "models/output.json",
          },
        ],
        relationships: [
          { from: "source:mesh-source", toRole: "model", kind: "derived" },
          { from: "member:model", toRole: "metadata", kind: "describes" },
        ],
        provenance: {
          source: "inputs/source.blend",
          rights: "fixture",
          visibility: "repository",
          lineage: [imported[0].ref.digest],
        },
      },
    ];
    const captured = await captureAssetSets(
      store,
      staging,
      item,
      sets,
      {
        harness: "scripted",
      },
      imported,
    );
    assert.equal(captured[0].inputs[0].ref.digest, imported[0].ref.digest);
    assert.deepEqual(captured[0].relationships, sets[0].relationships);
    assert.deepEqual(
      captured[0].members[0].formatMetadata,
      sets[0].members[0].formatMetadata,
    );
    const result = await materializeAssetSet({
      checkout,
      workRoot: join(root, "worktrees"),
      baseCommit: git(checkout, "rev-parse", "HEAD"),
      item,
      set: captured[0],
      store,
    });
    const pointer = git(
      checkout,
      "show",
      `${result.changeRef}:models/output.blend`,
    );
    assert.match(pointer, new RegExp(captured[0].members[0].ref.digest));
    assert.equal(
      git(checkout, "show", `${result.changeRef}:models/output.json`),
      '{"source":"inputs/source.blend"}',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
