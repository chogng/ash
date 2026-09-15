import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");

test("repository build orchestration and developer scripts have separate root owners", () => {
  for (const directory of ["ash-ts/scripts", "scripts/ash-ts", "build/desktop"]) {
    const path = join(repositoryRoot, directory);
    assert.equal(existsSync(path), false, `${directory} must not own repository tooling`);
  }
  for (const category of ["download", "lib", "pnpm", "app", "code", "remote", "darwin", "win32", "linux", "resources", "vite", "package"]) {
    assert.equal(existsSync(join(import.meta.dirname, category)), true, category);
  }
  for (const entry of ["cargo.py", "format.py", "just-shell.py", "test-python.py", "electron.ts", "web.ts"]) {
    assert.equal(existsSync(join(repositoryRoot, "scripts", entry)), true, entry);
  }
  assert.equal(existsSync(join(repositoryRoot, "ash-ts/test/unit/mocha.ts")), true);
  for (const retiredEntry of ["cargo_with_v8.py", "lib/just_shell.py"]) {
    assert.equal(existsSync(join(import.meta.dirname, retiredEntry)), false, retiredEntry);
  }
});

test("Node build and repository command sources do not use runtime JavaScript", () => {
  const javaScriptExtensions = new Set([".cjs", ".js", ".mjs", ".mts"]);
  const files = [...walk(import.meta.dirname), ...walk(join(repositoryRoot, "scripts"))];
  assert.deepEqual(files.filter((path) => javaScriptExtensions.has(extname(path))), []);
});

test("build tools do not import repository command implementations", () => {
  for (const path of walk(import.meta.dirname).filter((path) => extname(path) === ".py")) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /^\s*(?:from scripts(?:\.|\s)|import scripts(?:\.|\s|$))/m, path);
  }
  for (const path of walk(import.meta.dirname).filter(path => extname(path) === '.ts' && !path.endsWith('.test.ts'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s*|import\s*\()\s*["'][^"']*\/scripts\//u, path);
  }
  const runtime = join(repositoryRoot, 'ash-ts/src/ash/platform/app-server/node');
  for (const path of walk(runtime).filter(path => extname(path) === '.ts')) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /(?:from\s*|import\s*\()\s*["'][^"']*\/(?:build|scripts)\//u, path);
  }
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".venv") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}
