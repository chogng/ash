import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);

function source(path: string): string {
	return readFileSync(resolve(desktopRoot, path), "utf8");
}

test("Desktop packages the shared backend host instead of the Ash Code CLI", () => {
	const packageScript = source("../build/package/prepare.ts");
	const packageManifest = source("package.json");
	const watcher = source("../build/lib/watch/appServer.ts");
	const electronMain = source("src/ash/code/electron-main/app.ts");
	const forbiddenProductCrate = ["ash", "cli"].join("-");
	const forbiddenProductPath = ["ash", "code", "cli"].join("/");

	for (const [name, contents] of [["package script", packageScript], ["package manifest", packageManifest], ["Rust watcher", watcher], ["Electron Main", electronMain]] as const) {
		assert.equal(contents.includes(forbiddenProductCrate), false, `${name} must not reference the Ash Code CLI crate`);
		assert.equal(contents.includes(forbiddenProductPath), false, `${name} must not reference the Ash Code CLI source path`);
	}
	assert.match(packageScript, /"--bin", "ash-app-server"/u);
	assert.match(packageScript, /"--bin", "ash-app-server-daemon"/u);
	assert.match(packageManifest, /build\/package\/prepare\.ts/u);
	assert.match(packageScript, /"--profile",\s*"dev-small"/u);
	assert.match(watcher, /"--profile", "dev-small"/u);
	assert.doesNotMatch(packageScript, /"--target",/u);
	assert.doesNotMatch(watcher, /"--target",/u);
	assert.match(electronMain, /platform\/app-server\/electron-main\/appServerPackage\.js/u);
});
