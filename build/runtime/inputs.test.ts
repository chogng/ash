import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { packageInputDigest, recordPackageInputs, reusablePackage } from "./inputs.ts";

test("development package reuse follows source, settings, and published manifest changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-package-inputs-"));
  try {
    const source = join(root, "source");
    const packageRoot = join(root, "package");
    const cache = join(root, "prepare-inputs.json");
    await mkdir(source);
    await mkdir(packageRoot);
    await writeFile(join(source, "asset"), "one");
    await writeFile(join(packageRoot, "ash-package.json"), "{}");
    const initial = await packageInputDigest([source], { runtime: "host-provided-node" });
    assert.equal(await reusablePackage(cache, initial, () => packageRoot), undefined);
    await recordPackageInputs(cache, initial, packageRoot);
    assert.equal(await reusablePackage(cache, initial, () => packageRoot), packageRoot);
    assert.equal(await reusablePackage(cache, initial, () => join(root, "other")), undefined);
    assert.equal(await reusablePackage(cache, initial, () => { throw new Error("Ash development package has no published manifest: missing"); }), undefined);
    assert.equal(await reusablePackage(cache, await packageInputDigest([source], { runtime: "packaged-node" }), () => packageRoot), undefined);
    await writeFile(join(source, "asset"), "changed");
    assert.equal(await reusablePackage(cache, await packageInputDigest([source], { runtime: "host-provided-node" }), () => packageRoot), undefined);
    await rm(join(packageRoot, "ash-package.json"));
    assert.equal(await reusablePackage(cache, initial, () => packageRoot), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
