import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";
import { LocalExecutionDriver } from "../dist/execution/local.js";
import { sanitizedWorkerEnvironment } from "../dist/process.js";

function git(checkout, ...args) {
  return execFileSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
  }).trim();
}

function target(root, legacy = false, lfs = false) {
  const checkout = join(root, "target");
  mkdirSync(checkout);
  git(checkout, "init", "-b", "main");
  writeFileSync(join(checkout, "README.md"), "# Target\n");
  if (lfs) {
    git(checkout, "lfs", "install", "--local");
    writeFileSync(
      join(checkout, ".gitattributes"),
      "*.bin filter=lfs diff=lfs merge=lfs -text\n",
    );
  }
  if (legacy) {
    symlinkSync("README.md", join(checkout, "old-link"));
    writeFileSync(
      join(checkout, ".gitmodules"),
      '[submodule "old"]\n\tpath = vendor/old\n\turl = ../old\n',
    );
  }
  git(checkout, "add", "-A");
  if (legacy) {
    const head = git(checkout, "hash-object", "-w", "README.md");
    git(
      checkout,
      "update-index",
      "--add",
      "--cacheinfo",
      `160000,${head},vendor/old`,
    );
  }
  git(
    checkout,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "base",
  );
  return { checkout, baseSha: git(checkout, "rev-parse", "HEAD") };
}

async function runCandidate(change, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-local-safety-"));
  try {
    const { checkout, baseSha } = target(root, options.legacy, options.lfs);
    const harness = {
      async start(request) {
        change(request.worktree, root);
        return { identity: request.attemptId, data: {} };
      },
      async observe() {
        return { state: "complete" };
      },
      async cancel() {},
      async collect() {
        return { evidence: { harness: "scripted" } };
      },
    };
    const driver = new LocalExecutionDriver(
      checkout,
      join(root, "worktrees"),
      harness,
      1,
      new LocalContentStore(join(root, "content")),
    );
    const item = {
      id: "safety",
      title: "Safety fixture",
      ownedPaths: options.ownedPaths ?? ["safe.txt"],
    };
    const handle = await driver.start({ attemptId: "attempt", baseSha, item });
    return await driver.collect(handle);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unrelated existing symlink, submodule, and .gitmodules do not block an owned change", async () => {
  const result = await runCandidate(
    (worktree) => writeFileSync(join(worktree, "safe.txt"), "safe\n"),
    { legacy: true },
  );
  assert.match(result.changeRef, /^[a-f0-9]{40}$/);
});

test("new symlink and path escape stop collection", async () => {
  await assert.rejects(
    runCandidate((worktree, root) => {
      symlinkSync(root, join(worktree, "safe.txt"));
    }),
    /unsafe symlink|unsafe Git entry/,
  );
});

test("unowned content stops collection", async () => {
  await assert.rejects(
    runCandidate((worktree) =>
      writeFileSync(join(worktree, "other.txt"), "x\n"),
    ),
    /outside ownership: other.txt/,
  );
});

test("new special file stops collection before publication", async () => {
  await assert.rejects(
    runCandidate((worktree) => {
      writeFileSync(join(worktree, "safe.txt"), "safe\n");
      execFileSync("mkfifo", [join(worktree, "pipe")]);
    }),
    /special file at "pipe"/,
  );
});

test("suspected secret stops collection with rule and path but no value", async () => {
  const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  await assert.rejects(
    runCandidate((worktree) =>
      writeFileSync(join(worktree, "safe.txt"), `GITHUB_TOKEN=${value}\n`),
    ),
    (error) => {
      assert.match(
        error.message,
        /Secretlint found suspected secret in "safe.txt"/,
      );
      assert.match(error.message, /@secretlint\/secretlint-rule-github/);
      assert.match(error.message, /FACTORY_SECRETLINT_CONFIG/);
      assert.ok(!error.message.includes(value));
      return true;
    },
  );
});

test("LFS working bytes are scanned even when the staged blob is only a pointer", async () => {
  const value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const content = Buffer.alloc(4 * 1024 * 1024, 65);
  content.write(`GITHUB_TOKEN=${value}\n`, content.length - 64);
  await assert.rejects(
    runCandidate(
      (worktree) => writeFileSync(join(worktree, "payload.bin"), content),
      { lfs: true, ownedPaths: ["payload.bin"] },
    ),
    (error) => {
      assert.match(
        error.message,
        /Secretlint found suspected secret in "payload.bin"/,
      );
      assert.ok(!error.message.includes(value));
      return true;
    },
  );
});

test("a media worker cannot mutate a controller-owned final destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-media-destination-"));
  try {
    const checkout = join(root, "target");
    mkdirSync(join(checkout, "approved"), { recursive: true });
    git(checkout, "init", "-b", "main");
    const original = Buffer.from([1, 3, 3, 7]);
    writeFileSync(join(checkout, "approved/original.bin"), original);
    git(checkout, "add", "approved/original.bin");
    git(
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
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
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "LFS policy",
    );
    const harness = {
      async start(request) {
        writeFileSync(
          join(request.worktree, "approved/original.bin"),
          "worker mutation",
        );
        const directory = join(request.worktree, ".factory-media/candidate");
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "model.bin"), original);
        return { identity: request.attemptId, data: {} };
      },
      async observe() {
        return { state: "complete" };
      },
      async cancel() {},
      async collect() {
        return {
          evidence: { harness: "scripted" },
          assets: [
            {
              id: "candidate",
              members: [
                {
                  role: "model",
                  path: ".factory-media/candidate/model.bin",
                  mediaType: "application/octet-stream",
                  destination: "approved/original.bin",
                },
              ],
              provenance: {
                source: "approved/original.bin",
                rights: "fixture",
                visibility: "repository",
                lineage: ["approved/original.bin"],
              },
            },
          ],
        };
      },
    };
    const driver = new LocalExecutionDriver(
      checkout,
      join(root, "worktrees"),
      harness,
      1,
      new LocalContentStore(join(root, "content")),
    );
    const item = {
      id: "media",
      title: "Media fixture",
      ownedPaths: ["approved/original.bin"],
      sourceAssets: [
        {
          kind: "repository",
          path: "approved/original.bin",
          role: "source",
          mediaType: "application/octet-stream",
          visibility: "repository",
        },
      ],
      expectedOutputRoles: ["model"],
      minimumAssetSets: 1,
      requiredLfsRoles: ["model"],
    };
    const handle = await driver.start({
      attemptId: "attempt",
      baseSha: git(checkout, "rev-parse", "HEAD"),
      item,
      objectiveBody: "media fixture",
    });
    await assert.rejects(
      driver.collect(handle),
      /Bound asset input differs from its captured digest/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator-owned external scanner config can handle a reviewed false positive", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-secret-config-"));
  const config = join(root, "secretlint.json");
  const previous = process.env.FACTORY_SECRETLINT_CONFIG;
  try {
    writeFileSync(
      config,
      JSON.stringify({
        rules: [
          {
            id: "@secretlint/secretlint-rule-preset-recommend",
            rules: [
              {
                id: "@secretlint/secretlint-rule-github",
                allowMessageIds: ["GITHUB_TOKEN"],
              },
            ],
          },
        ],
      }),
    );
    process.env.FACTORY_SECRETLINT_CONFIG = config;
    const result = await runCandidate((worktree) =>
      writeFileSync(
        join(worktree, "safe.txt"),
        "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n",
      ),
    );
    assert.match(result.changeRef, /^[a-f0-9]{40}$/);
  } finally {
    if (previous === undefined) delete process.env.FACTORY_SECRETLINT_CONFIG;
    else process.env.FACTORY_SECRETLINT_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker receives only declared ambient values and an empty GitHub credential directory", () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, {
      GH_TOKEN: "github-write-secret",
      GITHUB_TOKEN: "github-write-secret",
      OPENAI_API_KEY: "declared-model-secret",
      AWS_SECRET_ACCESS_KEY: "host-secret",
      PGPASSWORD: "host-secret",
      DATABASE_URL: "postgres://user:secret@localhost/db",
      NPM_CONFIG_USERCONFIG: "/tmp/host-npmrc",
      SSH_AUTH_SOCK: "/tmp/host-agent",
      GIT_ASKPASS: "/tmp/host-askpass",
      PATH: "/usr/bin",
    });
    const env = sanitizedWorkerEnvironment("/tmp/factory-empty-gh-config");
    const effective = JSON.parse(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(JSON.stringify(process.env))"],
        {
          encoding: "utf8",
          env,
        },
      ),
    );
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "PGPASSWORD",
      "DATABASE_URL",
      "NPM_CONFIG_USERCONFIG",
      "SSH_AUTH_SOCK",
      "GIT_ASKPASS",
    ])
      assert.equal(effective[key], undefined, key);
    assert.equal(effective.PATH, "/usr/bin");
    assert.equal(effective.GH_CONFIG_DIR, "/tmp/factory-empty-gh-config");
    assert.equal(effective.GIT_CONFIG_KEY_0, "credential.helper");
    assert.equal(effective.GIT_CONFIG_VALUE_0, "");
    const declared = sanitizedWorkerEnvironment(
      "/tmp/factory-empty-gh-config",
      ["OPENAI_API_KEY", "GH_TOKEN"],
    );
    assert.equal(declared.OPENAI_API_KEY, "declared-model-secret");
    assert.equal(declared.GH_TOKEN, undefined);
  } finally {
    process.env = original;
  }
});
