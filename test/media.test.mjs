import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import {
  assertAssetCaptureReceipt,
  captureAssetSets,
  importSourceAssets,
  materializeAssetSet,
  parseProducedAssetSets,
  recognizedObjectiveAttachment,
} from "../dist/media.js";

test("private local source import retains its declared identity and exact bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-private-media-"));
  try {
    const path = join(root, "private.blend");
    const bytes = Buffer.from([0, 39, 245, 71]);
    writeFileSync(path, bytes);
    const binding = {
      kind: "local",
      path,
      role: "reference",
      mediaType: "application/x-blender",
      visibility: "private",
    };
    const store = new LocalContentStore(join(root, "store"));
    const [source] = await importSourceAssets(
      store,
      root,
      { sourceAssets: [binding] },
      `Use ${path} as the reference.`,
    );
    assert.deepEqual(source.binding, binding);
    assert.equal(
      source.ref.digest,
      createHash("sha256").update(bytes).digest("hex"),
    );
    await assert.rejects(
      importSourceAssets(
        store,
        root,
        { sourceAssets: [binding] },
        "unrelated Objective",
      ),
      /absolute private file/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("recognized Objective attachment import follows only GitHub content redirects", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-attachment-"));
  const url =
    "https://github.com/user-attachments/assets/12345678-1234-1234-1234-123456789abc";
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    assert.equal(recognizedObjectiveAttachment(url), true);
    assert.equal(
      recognizedObjectiveAttachment("https://evil.example/file"),
      false,
    );
    globalThis.fetch = async (target, init) => {
      requests.push({ target, init });
      return requests.length === 1
        ? new Response(null, {
            status: 302,
            headers: {
              location: "https://objects.githubusercontent.com/object",
            },
          })
        : new Response(Buffer.from([0, 255, 1]), {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
          });
    };
    const binding = {
      kind: "github-attachment",
      path: url,
      role: "reference",
      mediaType: "application/octet-stream",
      visibility: "private",
    };
    const store = new LocalContentStore(join(root, "store"));
    const [source] = await importSourceAssets(
      store,
      root,
      { sourceAssets: [binding] },
      `Attached: ${url}`,
      () => "test-token",
    );
    assert.equal(
      source.ref.digest,
      createHash("sha256")
        .update(Buffer.from([0, 255, 1]))
        .digest("hex"),
    );
    assert.equal(requests[0].init.headers.Authorization, "Bearer test-token");
    assert.deepEqual(requests[1].init.headers, {});
    await assert.rejects(
      importSourceAssets(
        store,
        root,
        { sourceAssets: [binding] },
        "no attachment",
        () => "test-token",
      ),
      /Objective body/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

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

test("a non-manifest harness keeps verified capture evidence without claiming manifest origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-non-manifest-media-"));
  try {
    const staging = join(root, "staging");
    const media = join(staging, ".factory-media", "candidate-a");
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, "image.png"), Buffer.from([1, 2, 3]));
    const sets = [
      {
        id: "candidate-a",
        members: [
          {
            role: "image",
            path: ".factory-media/candidate-a/image.png",
            mediaType: "image/png",
            destination: "approved/image.png",
          },
        ],
        provenance: {
          source: "generated",
          rights: "fixture",
          visibility: "repository",
          lineage: [],
        },
      },
    ];
    const externalManifest = join(root, "external-manifest.json");
    writeFileSync(externalManifest, `${JSON.stringify({ sets })}\n`);
    symlinkSync(externalManifest, join(staging, ".factory-assets.json"));
    await assert.rejects(
      captureAssetSets(
        new LocalContentStore(join(root, "rejected-content")),
        staging,
        { ownedPaths: ["approved/image.png"], expectedOutputRoles: ["image"] },
        sets,
        { harness: "provider-neutral" },
      ),
      /not a regular staging file/,
    );
    rmSync(join(staging, ".factory-assets.json"));
    const [captured] = await captureAssetSets(
      new LocalContentStore(join(root, "content")),
      staging,
      { ownedPaths: ["approved/image.png"], expectedOutputRoles: ["image"] },
      sets,
      { harness: "provider-neutral" },
    );
    assert.equal(captured.capture.authority, "factory-controller");
    assert.equal(captured.capture.declarationPath, undefined);
    assert.equal(captured.capture.declarationDigest, undefined);
    assert.equal(captured.capture.declarationProvenance, undefined);
    assert.equal(
      captured.capture.members[0].stagingPath,
      ".factory-media/candidate-a/image.png",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exact repository source can migrate its existing path to required LFS without worker deletion", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-same-path-lfs-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(join(checkout, "approved"), { recursive: true });
    git(checkout, "init", "-b", "main");
    const destination = "approved/original.bin";
    const bytes = Buffer.from([0, 81, 0, 255, 14, 92]);
    writeFileSync(join(checkout, destination), bytes);
    git(checkout, "add", destination);
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "ordinary source",
    );
    writeFileSync(
      join(checkout, ".gitattributes"),
      "approved/*.bin filter=lfs diff=lfs merge=lfs -text\n",
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
      "require LFS",
    );
    const baseCommit = git(checkout, "rev-parse", "HEAD");
    const item = {
      id: "same-path",
      ownedPaths: [destination],
      sourceAssets: [
        {
          kind: "repository",
          path: destination,
          role: "original",
          mediaType: "application/octet-stream",
          visibility: "repository",
        },
      ],
      requiredLfsRoles: ["model"],
    };
    const store = new LocalContentStore(join(root, "content"));
    const inputs = await importSourceAssets(store, checkout, item);
    const set = {
      id: "byte-identical",
      members: [
        {
          role: "model",
          ref: inputs[0].ref,
          destination,
        },
      ],
      inputs,
      provenance: {
        source: destination,
        rights: "repository fixture",
        visibility: "repository",
        lineage: [inputs[0].ref.digest],
      },
      evidence: { harnessIdentity: "fixture", resultDigest: "fixture" },
    };

    const result = await materializeAssetSet({
      checkout,
      workRoot: join(root, "worktrees"),
      baseCommit,
      item,
      set,
      store,
    });
    const pointer = git(checkout, "show", `${result.changeRef}:${destination}`);
    assert.match(pointer, /version https:\/\/git-lfs.github.com\/spec\/v1/);
    assert.match(pointer, new RegExp(inputs[0].ref.digest));
    assert.match(pointer, new RegExp(`size ${bytes.length}`));

    await assert.rejects(
      materializeAssetSet({
        checkout,
        workRoot: join(root, "worktrees"),
        baseCommit,
        item,
        set: { ...set, inputs: [] },
        store,
      }),
      /would overwrite approved\/original\.bin/,
    );
    const changedPath = join(root, "changed.bin");
    writeFileSync(changedPath, Buffer.from([9, 8, 7]));
    const changedRef = await store.importFile(changedPath, {
      mediaType: "application/octet-stream",
    });
    await assert.rejects(
      materializeAssetSet({
        checkout,
        workRoot: join(root, "worktrees"),
        baseCommit,
        item,
        set: {
          ...set,
          members: [{ ...set.members[0], ref: changedRef }],
        },
        store,
      }),
      /would overwrite approved\/original\.bin/,
    );
    await assert.rejects(
      materializeAssetSet({
        checkout,
        workRoot: join(root, "worktrees"),
        baseCommit,
        item: { ...item, requiredLfsRoles: [] },
        set,
        store,
      }),
      /would overwrite approved\/original\.bin/,
    );
    assert.deepEqual(readFileSync(join(checkout, destination)), bytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("asset materialization rejects symlink parents and submodule boundaries before writing", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-media-boundary-"));
  try {
    const checkout = join(root, "target");
    const outside = join(root, "outside");
    mkdirSync(checkout);
    mkdirSync(outside);
    git(checkout, "init", "-b", "main");
    symlinkSync(outside, join(checkout, "linked"));
    writeFileSync(join(checkout, "README.md"), "boundary fixture\n");
    git(checkout, "add", "README.md", "linked");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "symlink boundary",
    );

    const nested = join(root, "nested");
    mkdirSync(nested);
    git(nested, "init", "-b", "main");
    writeFileSync(join(nested, "README.md"), "nested fixture\n");
    git(nested, "add", "README.md");
    git(
      nested,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "nested",
    );
    git(
      checkout,
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      nested,
      "vendor",
    );
    git(checkout, "add", ".gitmodules", "vendor");
    git(
      checkout,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "submodule boundary",
    );

    const source = join(root, "source.bin");
    writeFileSync(source, Buffer.from([1, 2, 3, 4]));
    const store = new LocalContentStore(join(root, "content"));
    const ref = await store.importFile(source, {
      mediaType: "application/octet-stream",
    });
    const setFor = (destination) => ({
      id: "candidate",
      members: [{ role: "model", ref, destination }],
      provenance: {
        source: "fixture",
        rights: "fixture",
        visibility: "repository",
        lineage: [ref.digest],
      },
      evidence: { harnessIdentity: "fixture", resultDigest: "fixture" },
    });
    const baseCommit = git(checkout, "rev-parse", "HEAD");
    await assert.rejects(
      materializeAssetSet({
        checkout,
        workRoot: join(root, "worktrees"),
        baseCommit,
        item: { id: "linked", ownedPaths: ["linked/output.bin"] },
        set: setFor("linked/output.bin"),
        store,
      }),
      /crosses a symlink/,
    );
    assert.equal(existsSync(join(outside, "output.bin")), false);
    await assert.rejects(
      materializeAssetSet({
        checkout,
        workRoot: join(root, "worktrees"),
        baseCommit,
        item: { id: "vendor", ownedPaths: ["vendor/output.bin"] },
        set: setFor("vendor/output.bin"),
        store,
      }),
      /crosses a submodule/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
          annotation: "unrecognized manifest extension",
        },
      },
    ];
    writeFileSync(
      join(staging, ".factory-assets.json"),
      `${JSON.stringify({ sets: [{ ...sets[0], id: "mismatch" }] })}\n`,
    );
    await assert.rejects(
      captureAssetSets(
        store,
        staging,
        item,
        sets,
        { harness: "scripted" },
        imported,
      ),
      /differ from \.factory-assets\.json/,
    );
    writeFileSync(
      join(staging, ".factory-assets.json"),
      `${JSON.stringify({ sets })}\n`,
    );
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
    assert.deepEqual(
      captured[0].capture.members.map((member) => [
        member.role,
        member.stagingPath,
        member.destination,
      ]),
      [
        [
          "model",
          ".factory-media/candidate-a/model.blend",
          "models/output.blend",
        ],
        [
          "metadata",
          ".factory-media/candidate-a/details.json",
          "models/output.json",
        ],
      ],
    );
    assert.match(captured[0].capture.declarationDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(captured[0].capture.declarationProvenance, {
      source: sets[0].provenance.source,
      rights: sets[0].provenance.rights,
      visibility: sets[0].provenance.visibility,
      lineage: sets[0].provenance.lineage,
    });
    assert.doesNotThrow(() => assertAssetCaptureReceipt(captured[0]));
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

test("selected LFS media is scanned before its materialization commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-selected-secret-"));
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  try {
    const checkout = join(root, "target");
    mkdirSync(checkout);
    git(checkout, "init", "-b", "main");
    writeFileSync(
      join(checkout, ".gitattributes"),
      "media/*.bin filter=lfs diff=lfs merge=lfs -text\n",
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
      "policy",
    );
    const baseCommit = git(checkout, "rev-parse", "HEAD");
    const store = new LocalContentStore(join(root, "content"));
    const bytes = Buffer.from(`GITHUB_TOKEN=${secret}\n`);
    const ref = await store.put(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      { mediaType: "application/octet-stream" },
    );
    await assert.rejects(
      materializeAssetSet({
        checkout,
        workRoot: join(root, "worktrees"),
        baseCommit,
        item: {
          id: "media",
          ownedPaths: ["media/selected.bin"],
          requiredLfsRoles: ["model"],
        },
        set: {
          id: "candidate",
          members: [{ role: "model", ref, destination: "media/selected.bin" }],
        },
        store,
      }),
      (error) => {
        assert.match(
          error.message,
          /Secretlint found suspected secret in "media\/selected.bin"/,
        );
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
    assert.equal(git(checkout, "rev-parse", "HEAD"), baseCommit);
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
    writeFileSync(
      join(staging, ".factory-assets.json"),
      `${JSON.stringify({ sets })}\n`,
    );
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
