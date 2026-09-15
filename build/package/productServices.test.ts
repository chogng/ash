import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { validateProductServices } from "./productServices.ts";

const official = { name: "ash", trustedRoot: "marketplace-root.json" };

async function writeSources(root: string, sources: unknown[]): Promise<void> {
  await writeFile(join(root, "product-services.json"), JSON.stringify({ schemaVersion: 2, marketplaces: sources }));
}

test("validates every configured Marketplace trust root in the package", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-services-"));
  try {
    await mkdir(join(root, "vendor"));
    await writeFile(join(root, "marketplace-root.json"), "official root");
    await writeFile(join(root, "vendor", "root.json"), "vendor root");
    await writeSources(root, [official, { name: "vendor", trustedRoot: "vendor/root.json" }]);
    await validateProductServices(root);
    await rm(join(root, "vendor", "root.json"));
    await assert.rejects(validateProductServices(root), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects duplicate or unsafe source names and uncontained or empty roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-product-services-"));
  try {
    await writeFile(join(root, "marketplace-root.json"), "official root");
    await writeFile(join(root, "empty.json"), "");
    for (const source of [
      official,
      { name: "vendor\n", trustedRoot: "marketplace-root.json" },
      { name: "vendor", trustedRoot: "../root.json" },
      { name: "vendor", trustedRoot: "/root.json" },
      { name: "vendor", trustedRoot: "C:\\root.json" },
      { name: "vendor", trustedRoot: "empty.json" },
    ]) {
      await writeSources(root, [official, source]);
      await assert.rejects(validateProductServices(root));
    }
    await writeFile(join(root, "product-services.json"), JSON.stringify({ schemaVersion: 1, marketplaces: [official] }));
    await assert.rejects(validateProductServices(root), /configuration is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects trust roots reached through a symbolic directory", { skip: process.platform === "win32" }, async () => {
  const parent = await mkdtemp(join(tmpdir(), "ash-product-services-"));
  const root = join(parent, "product");
  try {
    await mkdir(root);
    await writeFile(join(root, "marketplace-root.json"), "official root");
    await writeFile(join(parent, "root.json"), "outside root");
    await symlink(parent, join(root, "linked"), "dir");
    await writeSources(root, [official, { name: "vendor", trustedRoot: "linked/root.json" }]);
    await assert.rejects(validateProductServices(root), /bounded regular file/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
