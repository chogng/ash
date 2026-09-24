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
	const packageScript = source("../build/ash_rs/prepare.py");
	const packageManifest = source("package.json");
	const watcher = source("../build/app_ts/appServer.ts");
	const backendBuilder = source("../build/ash_rs/develop.py");
	const electronMain = source("src/ash/code/electron-main/app.ts");
	const forbiddenProductCrate = ["ash", "cli"].join("-");
	const forbiddenProductPath = ["ash", "code", "cli"].join("/");

	for (const [name, contents] of [["package script", packageScript], ["package manifest", packageManifest], ["frontend watcher", watcher], ["backend builder", backendBuilder], ["Electron Main", electronMain]] as const) {
		assert.equal(contents.includes(forbiddenProductCrate), false, `${name} must not reference the Ash Code CLI crate`);
		assert.equal(contents.includes(forbiddenProductPath), false, `${name} must not reference the Ash Code CLI source path`);
	}
	assert.match(packageScript, /"ash-app-server": None/u);
	assert.match(packageScript, /"ash-app-server-daemon": None/u);
	assert.match(packageManifest, /build\/ash_rs\/prepare\.py/u);
	assert.match(packageScript, /PROFILE = "dev-small"/u);
	assert.match(watcher, /build\/ash_rs\/develop\.py/u);
	assert.match(backendBuilder, /PROFILE = "dev-small"/u);
	assert.match(backendBuilder, /host_build=True/u);
	assert.doesNotMatch(packageScript, /"--target",/u);
	assert.doesNotMatch(watcher, /spawn\(['"]cargo['"]/u);
	assert.match(electronMain, /platform\/app-server\/electron-main\/appServerPackage\.js/u);
});
