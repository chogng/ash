import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("installation accepts only the declared Node and package manager", async () => {
  const root = await mkdtemp(join(tmpdir(), "ash-preinstall-"));
  try {
    const entry = join(root, "build/pnpm/preinstall.ts");
    await mkdir(join(root, "build/pnpm"), { recursive: true });
    await copyFile(join(import.meta.dirname, "preinstall.ts"), entry);
    await writeFile(join(root, ".nvmrc"), process.versions.node);
    await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", packageManager: "pnpm@12.4.2" }));
    for (const agent of ["pnpm/12.4.2 npm/?", "pnpm/11.17.0", "npm/11.0.0", ""]) {
      const result = spawnSync(process.execPath, [entry], {
        env: { ...process.env, npm_config_user_agent: agent }, encoding: "utf8", windowsHide: true,
      });
      if (agent.startsWith("pnpm/12.4.2")) {
        assert.equal(result.status, 0, result.stderr);
      } else {
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Use pnpm@12\.4\.2/);
      }
    }
    for (const packageManager of [undefined, "pnpm", "pnpm@"]) {
      await writeFile(join(root, "package.json"), JSON.stringify({ type: "module", packageManager }));
      const result = spawnSync(process.execPath, [entry], { encoding: "utf8", windowsHide: true });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /must declare packageManager|Invalid packageManager value/);
    }
    await writeFile(join(root, ".nvmrc"), "0.0.0");
    const result = spawnSync(process.execPath, [entry], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node major version specified in .nvmrc/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
