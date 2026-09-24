import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "mocha";
import { findDesktopRoot } from "./testPaths.js";

const desktopRoot = findDesktopRoot(import.meta.dirname);
const buildRoot = resolve(desktopRoot, "../build/desktop/vite");
const scriptsRoot = resolve(desktopRoot, "../scripts");

test("hot reload separates the base runtime from Vite build integration", () => {
	const runtime = read("src/ash/base/common/hotReload.ts");
	const helpers = read("src/ash/base/common/hotReloadHelpers.ts");
	const setup = readBuild("setup-dev.ts");
	const plugin = readBuild("hotReloadPlugin.ts");
	const config = readBuild("vite.config.ts");

	assert.match(runtime, /registerHotReloadHandler/u);
	assert.match(runtime, /\$hotReload_applyNewExports/u);
	assert.doesNotMatch(runtime, /from\s+["']vite["']|import\.meta\.hot|workbench/u);
	assert.match(helpers, /readHotReloadableExport/u);
	assert.match(helpers, /observeHotReloadableExports/u);
	assert.match(helpers, /createHotClass/u);
	assert.doesNotMatch(helpers, /from\s+["']vite["']|import\.meta\.hot|workbench/u);
	assert.match(setup, /base\/common\/hotReload\.ts/u);
	assert.match(setup, /enableHotReload\(\)/u);
	assert.match(plugin, /type Plugin/u);
	assert.match(plugin, /handleHotUpdate/u);
	assert.match(config, /hotReloadPlugin/u);
});

test("Vite build ownership does not leak back into Workbench sources or scripts", () => {
	assert.equal(existsSync(join(desktopRoot, "vite.config.ts")), false);
	assert.equal(existsSync(join(desktopRoot, "src/ash/workbench/browser/devHotReload.ts")), false);
	assert.doesNotMatch(read("src/ash/workbench/workbench.web.main.ts"), /hotReload/u);
	assert.doesNotMatch(read("src/ash/workbench/workbench.desktop.main.ts"), /hotReload/u);
	assert.deepEqual(readdirSync(scriptsRoot).filter(file => /vite-plugin/u.test(file)), []);
	for (const file of ["hotReloadAnalysis.ts", "hotReloadPlugin.ts", "productIconsPlugin.ts", "setup-dev.ts", "vite.config.ts", "webAppServerPlugin.ts", "workbenchEntryPlugin.ts"]) {
		assert.equal(existsSync(join(buildRoot, file)), true, file);
	}
});

test("Desktop Vite commands select the Desktop build config", () => {
	const manifest = JSON.parse(read("package.json")) as { readonly scripts: Readonly<Record<string, string>> };
	for (const name of ["build", "build:renderer"]) {
		assert.match(manifest.scripts[name], /\.\.\/build\/desktop\/compile\.ts/u, name);
	}
	for (const name of ["dev", "dev:ui", "dev:renderer", "dev:web", "dev:web:full"]) {
		assert.match(manifest.scripts[name], /\.\.\/build\/desktop\/vite\/vite\.config\.ts/u, name);
	}
	assert.match(readFileSync(resolve(buildRoot, "../compile.ts"), "utf8"), /build\/desktop\/vite\/vite\.config\.ts/u);
});

function read(relativePath: string): string {
	return readFileSync(join(desktopRoot, relativePath), "utf8");
}

function readBuild(relativePath: string): string {
	return readFileSync(join(buildRoot, relativePath), "utf8");
}
