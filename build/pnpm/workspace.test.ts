import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("Node version declarations agree with the build runtime", () => {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  const version = readFileSync(join(repositoryRoot, ".nvmrc"), "utf8").trim();
  assert.match(version, /^24\.\d+\.\d+$/);
  assert.equal(manifest.engines.node, ">=24 <25");
  assert.deepEqual(manifest.devEngines.runtime, { name: "node", version, onFail: "download" });
  const result = spawnSync(process.execPath, [join(repositoryRoot, "build/pnpm/preinstall.ts")], {
    env: { ...process.env, npm_config_user_agent: `pnpm/${manifest.packageManager.split("@")[1]}` },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
});

test("pnpm owns every repository Node project with one lockfile", () => {
  const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")) as {
    packageManager?: string;
    engines?: { pnpm?: string };
    scripts?: Record<string, string>;
  };
  const workspace = readFileSync(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");
  const lockfile = readFileSync(join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
  assert.equal(rootManifest.packageManager, "pnpm@12.4.2");
  assert.equal(rootManifest.engines?.pnpm, "12.4.2");
  assert.equal(rootManifest.scripts?.preinstall, "node build/pnpm/preinstall.ts");
  assert.ok(lockfile.includes(`specifier: runtime:${readFileSync(join(repositoryRoot, ".nvmrc"), "utf8").trim()}`));
  const packages = [...workspace.matchAll(/^  - (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(packages, ["build", "app-ts"]);
  assert.doesNotMatch(workspace, /^storeDir:/m);
  for (const dependency of ["electron", "esbuild", "sharp", "unrs-resolver", "workerd"]) {
    assert.match(workspace, new RegExp(`^  ${dependency}: true$`, "m"));
  }

  for (const directory of packages) {
    const manifest = JSON.parse(readFileSync(join(repositoryRoot, directory, "package.json"), "utf8")) as {
      packageManager?: string;
      pnpm?: unknown;
      scripts?: Record<string, string>;
    };
    assert.equal(manifest.packageManager, undefined, `${directory}/package.json must inherit the root package manager`);
    assert.equal(manifest.pnpm, undefined, `${directory}/package.json must not duplicate workspace pnpm policy`);
    assert.equal(existsSync(join(repositoryRoot, directory, "package-lock.json")), false, directory);
    assert.equal(existsSync(join(repositoryRoot, directory, "pnpm-lock.yaml")), false, directory);
    assert.match(lockfile, new RegExp(`^  ${directory}:$`, "m"));
    for (const script of Object.values(manifest.scripts ?? {})) {
      assert.doesNotMatch(script, /(^|[;&|]\s*)npm(?:\s|$)/, `${directory} scripts must use pnpm`);
      assert.doesNotMatch(script, /node\s+(?:-e|--eval)\b/, `${directory} scripts must use owned TypeScript files`);
    }
  }
});
