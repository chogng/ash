import assert from "node:assert/strict";
import { resolve, join, dirname } from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createServer, normalizePath } from "vite";
import { analyzeHotReloadModule, unsafeHotReloadChangeReason } from "./hotReloadAnalysis.ts";
import { hotReloadPlugin, type AshHotReloadPlugin } from "./hotReloadPlugin.ts";

test("Vite hot reload injects setup and a generic export-handler boundary", () => {
	const setupPath = resolve("/workspace/build/desktop/vite/setup-dev.ts");
	const plugin = hotReloadPlugin({ desktopRoot: "/workspace", setupPath });
	const transformed = transform(plugin, "export class SidebarPart extends PaneCompositePart {}", "/workspace/src/ash/sidebarPart.ts?direct");
	const htmlTags = plugin.transformIndexHtml.handler();

	assert.equal(typeof transformed, "string");
	assert.ok(transformed);
	assert.match(transformed, /src\/ash\/sidebarPart\.ts/u);
	assert.match(transformed, /__ashViteHotReloadExports/u);
	assert.match(transformed, /\$hotReload_applyNewExports/u);
	assert.match(transformed, /import\.meta\.hot\.accept/u);
	assert.doesNotMatch(transformed, /\$ashHotReload_registerClass/u);
	assert.deepEqual(htmlTags, [{ tag: "script", attrs: { type: "module", src: `/@fs/${normalizePath(setupPath).replace(/^\/+/, "")}` }, injectTo: "head-prepend" }]);
});

test("Vite hot reload emits a valid Windows file URL for setup", () => {
	const plugin = hotReloadPlugin({ desktopRoot: "C:\\workspace", setupPath: "C:\\workspace\\build\\desktop\\vite\\setup-dev.ts" });
	const htmlTags = plugin.transformIndexHtml.handler();

	assert.deepEqual(htmlTags, [{ tag: "script", attrs: { type: "module", src: "/@fs/C:/workspace/build/desktop/vite/setup-dev.ts" }, injectTo: "head-prepend" }]);
});

test("Vite hot reload supports explicit prototype-patch opt in", () => {
	const plugin = hotReloadPlugin({ desktopRoot: "/workspace" });
	const transformed = transform(plugin, "// @ash-hot-reload patch-prototype\nexport class CustomSurface extends BaseSurface {}", "/workspace/src/ash/customSurface.ts");
	assert.ok(transformed);
	assert.match(transformed, /CustomSurface/u);
});

test("Vite hot reload exposes general runtime exports for helper-driven invalidation", () => {
	const plugin = hotReloadPlugin({ desktopRoot: "/workspace" });
	const transformed = transform(plugin, "export function compute() { return 1; } export const label = 'one';", "/workspace/src/ash/feature.ts");
	assert.ok(transformed);
	assert.match(transformed, /\{ compute, label \}/u);
	assert.ok(transformed.indexOf("$hotReload_applyNewExports") > transformed.indexOf("import.meta.hot.accept"));
	assert.match(transformed, /config: \{\}/u);
});

test("Vite hot reload leaves type-only modules and production builds unchanged", () => {
	const plugin = hotReloadPlugin({ desktopRoot: "/workspace" });
	assert.equal(plugin.apply, "serve");
	assert.equal(transform(plugin, "export interface Configuration { value: string; }", "/workspace/src/ash/configuration.ts"), undefined);
	assert.equal(transform(plugin, "interface Configuration { value: string; } export type { Configuration };", "/workspace/src/ash/configuration.ts"), undefined);
	assert.equal(transform(plugin, "export declare const injected: string;", "/workspace/src/ash/environment.ts"), undefined);
	assert.equal(transform(plugin, "export class SidebarPart extends PaneCompositePart {}", "/workspace/src/ash/sidebarPart.js"), undefined);
});

test("Vite hot reload accepts instance method and accessor changes", () => {
	const before = analyzeHotReloadModule("export class SidebarPart extends BasePart { render() { return 1; } get label() { return 'one'; } }");
	const after = analyzeHotReloadModule("export class SidebarPart extends BasePart { paint() { return 2; } get label() { return 'two'; } }");
	assert.equal(unsafeHotReloadChangeReason(before, after), undefined);
});

test("Vite hot reload rejects initialization and module-boundary changes", () => {
	const base = analyzeHotReloadModule("import { value } from './value.js'; export class SidebarPart extends BasePart { label = value; render() {} }");
	const constructorChanged = analyzeHotReloadModule("import { value } from './value.js'; export class SidebarPart extends BasePart { label = value; constructor() { super(); } render() {} }");
	const fieldChanged = analyzeHotReloadModule("import { value } from './value.js'; export class SidebarPart extends BasePart { label = value + 'changed'; render() {} }");
	const staticChanged = analyzeHotReloadModule("import { value } from './value.js'; export class SidebarPart extends BasePart { static kind = 'sidebar'; label = value; render() {} }");
	const importChanged = analyzeHotReloadModule("import { value } from './other.js'; export class SidebarPart extends BasePart { label = value; render() {} }");

	assertUnsafeReason(unsafeHotReloadChangeReason(base, constructorChanged), /constructor/u);
	assertUnsafeReason(unsafeHotReloadChangeReason(base, fieldChanged), /field/u);
	assertUnsafeReason(unsafeHotReloadChangeReason(base, staticChanged), /static/u);
	assertUnsafeReason(unsafeHotReloadChangeReason(base, importChanged), /module/u);
});

test("Vite hot reload sends a full reload before an unsafe module executes", async () => {
	const plugin = hotReloadPlugin({ desktopRoot: "/workspace" });
	const file = "/workspace/src/ash/sidebarPart.ts";
	transform(plugin, "export class SidebarPart extends BasePart { render() {} }", file);
	const messages: Array<{ readonly type: "full-reload"; readonly path: "*"; }> = [];
	const logs: string[] = [];
	const result = await plugin.handleHotUpdate({
		file,
		read: async () => "export class SidebarPart extends OtherPart { render() {} }",
		server: { config: { logger: { info: message => logs.push(message) } }, ws: { send: message => messages.push(message) } },
	});

	assert.deepEqual(result, []);
	assert.deepEqual(messages, [{ type: "full-reload", path: "*" }]);
	assert.match(logs[0], /inheritance/u);
});

test("Vite hot reload keeps HMR for a safe method-only update", async () => {
	const plugin = hotReloadPlugin({ desktopRoot: "/workspace" });
	const file = "/workspace/src/ash/sidebarPart.ts";
	transform(plugin, "export class SidebarPart extends BasePart { render() { return 1; } }", file);
	const messages: Array<{ readonly type: "full-reload"; readonly path: "*"; }> = [];
	const result = await plugin.handleHotUpdate({
		file,
		read: async () => "export class SidebarPart extends BasePart { render() { return 2; } }",
		server: { config: { logger: { info() { } } }, ws: { send: message => messages.push(message) } },
	});
	assert.equal(result, undefined);
	assert.deepEqual(messages, []);
});

test("Vite hot reload lets helper-driven modules reach the runtime handler", async () => {
	const plugin = hotReloadPlugin({ desktopRoot: "/workspace" });
	const file = "/workspace/src/ash/feature.ts";
	transform(plugin, "export function compute() { return 1; }", file);
	const messages: Array<{ readonly type: "full-reload"; readonly path: "*"; }> = [];
	const result = await plugin.handleHotUpdate({
		file,
		read: async () => "export function compute() { return 2; }",
		server: { config: { logger: { info() { } } }, ws: { send: message => messages.push(message) } },
	});
	assert.equal(result, undefined);
	assert.deepEqual(messages, []);
});

test("Vite watches renderer CSS before its first transform and serves a concurrent save", { timeout: 10_000 }, async () => {
	const fixture = await mkdtemp(join(tmpdir(), "ash-css-hmr-"));
	const root = join(fixture, "src/ash/code");
	const styles = join(fixture, "src/ash/sessions/browser");
	const source = join(styles, "activity.css");
	const original = ".activity { width: 24px; }";
	const updated = ".activity { width: 16px; }";
	await mkdir(root, { recursive: true });
	await mkdir(styles, { recursive: true });
	await writeFile(source, original);
	let saved = false;
	const events: unknown[] = [];
	const server = await createServer({
		configFile: false,
		root,
		logLevel: "silent",
		optimizeDeps: { noDiscovery: true },
		server: { host: "127.0.0.1", port: 0, fs: { allow: [fixture] } },
		plugins: [hotReloadPlugin({ desktopRoot: fixture }), {
			name: "css-save-during-first-transform",
			configureServer(server) {
				server.watcher.on("all", (event, file) => events.push({ event, file }));
			},
			transform: {
				order: "pre",
				handler(code, id) {
					if (id !== normalizePath(source) || saved) return;
					assert.equal(code, original);
					saved = true;
					// Model a save between reading the CSS and caching its first transform.
					writeFileSync(source, updated);
				},
			},
		}],
	});
	try {
		await server.listen();
		const watchDeadline = Date.now() + 2_000;
		while (!server.watcher.getWatched()[styles]?.includes("activity.css") && Date.now() < watchDeadline) {
			await delay(20);
		}
		assert.ok(server.watcher.getWatched()[styles]?.includes("activity.css"), "Renderer CSS must be watched before a client loads it");
		const url = `/@fs/${normalizePath(source)}`;
		await server.environments.client.transformRequest(url);
		let served = "";
		const deadline = Date.now() + 2_000;
		do {
			served = (await server.environments.client.transformRequest(url))!.code;
			if (served.includes(updated)) break;
			await delay(20);
		} while (Date.now() < deadline);
		assert.deepEqual({ disk: await readFile(source, "utf8"), servesUpdated: served.includes(updated) }, { disk: updated, servesUpdated: true }, JSON.stringify({ events, watched: server.watcher.getWatched() }));
	} finally {
		await server.close();
		assert.equal(dirname(fixture), tmpdir());
		await rm(fixture, { recursive: true, force: true });
	}
});

function transform(plugin: AshHotReloadPlugin, code: string, id: string): string | undefined {
	return plugin.transform.handler(code, id);
}

function assertUnsafeReason(reason: string | undefined, pattern: RegExp): void {
	assert.ok(reason);
	assert.match(reason, pattern);
}
