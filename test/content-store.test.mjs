import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalContentStore } from "../dist/content/local.js";

test("content store streams a representative large file through put, verify, and materialize", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-content-test-"));
  try {
    const store = new LocalContentStore(join(root, "objects"));
    const chunk = new Uint8Array(64 * 1024).fill(0x5a);
    let count = 0;
    const source = new ReadableStream({
      pull(controller) {
        if (count++ < 128) controller.enqueue(chunk);
        else controller.close();
      },
    });
    const ref = await store.put(source, {
      mediaType: "application/octet-stream",
    });
    assert.equal(ref.bytes, 8 * 1024 * 1024);
    await store.verify(ref);
    const destination = join(root, "copy.bin");
    await store.materialize(ref, destination);
    assert.equal(readFileSync(destination).length, ref.bytes);
    assert.equal(
      readdirSync(join(root, "objects")).filter((name) => name.endsWith(".tmp"))
        .length,
      0,
    );
    writeFileSync(
      join(root, "objects", ref.digest.slice(0, 2), ref.digest),
      "corrupted",
    );
    await assert.rejects(store.verify(ref), /digest verification/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("failed input stream leaves no partial content object", async () => {
  const root = mkdtempSync(join(tmpdir(), "factory-content-failure-"));
  try {
    const store = new LocalContentStore(join(root, "objects"));
    let count = 0;
    const source = new ReadableStream({
      pull(controller) {
        if (count++ === 0) controller.enqueue(new Uint8Array([1, 2, 3]));
        else controller.error(new Error("source failed"));
      },
    });
    await assert.rejects(
      store.put(source, { mediaType: "application/octet-stream" }),
      /source failed/,
    );
    assert.deepEqual(readdirSync(join(root, "objects")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
