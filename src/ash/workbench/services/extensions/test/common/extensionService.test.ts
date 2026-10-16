import '../../../../contrib/speech/browser/speechService.js';
import { createEmptyTestLanguagePacks } from '../../../localization/test/common/localizationTestUtils.js';
import { JSDOM } from 'jsdom';
import { GlobalExtensionEnablementService } from '../../../../../platform/extensionManagement/common/extensionEnablementService.js';
import { BrowserStorageService } from '../../../storage/browser/storageService.js';
import { createAppServerExtensionApi, withEnabledBuiltInExtensions } from '../../../../../platform/extensions/browser/extensionApi.js';
import { Emitter } from '../../../../../base/common/event.js';
import type { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import type { AppServerConnectionState, IResourceApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { ViewsRegistry } from '../../../../common/views.js';
import { normalizeExtensionCatalog } from '../../../../../platform/extensions/common/extensionApi.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { TestConfigurationService as WorkbenchConfigurationService } from '../../../configuration/test/common/testServices.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "mocha";
import { readFile, readdir } from 'node:fs/promises';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { WorkbenchFileIconThemesRegistry } from '../../../themes/common/themeExtensionPoints.js';
import { DisposableTracker, installDisposableTracker, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { ExtensionCatalog, ExtensionDescriptor, IExtensionApi } from "../../../../../platform/extensions/common/extensionApi.js";
import type { IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import type { ServerNotification } from "../../../../../../../.build/protocol/typescript/index.js";
import { AppServerExtensionService } from "../../browser/appServerExtensionService.js";
import { parseExtensionManifest, type ExtensionCatalog as WorkbenchExtensionCatalog } from "../../common/extensionService.js";
import { parseJsonc } from "../../common/jsonc.js";
import { SnippetsService } from '../../../../contrib/snippets/browser/snippetsService.js';
import { MainThreadLocalization } from '../../../../api/browser/mainThreadLocalization.js';
import { ExtensionThemeRegistry, parseExtensionTheme } from "../../common/extensionTheme.js";
import { ExtensionDebugAdapterRegistry } from "../../common/extensionDebugAdapter.js";
import { DebugAdapterFactoriesRegistry } from "../../../debug/common/debugAdapterFactory.js";
import { parseProblemMatchers } from '../../../tasks/common/problemMatcher.js';
import { WatchingProblemCollector } from '../../../../contrib/tasks/common/problemCollectors.js';
import { MarkerService } from '../../../../../platform/markers/common/markerService.js';
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { URI } from "../../../../../base/common/uri.js";

const descriptorManifest = JSON.stringify({
	name: "demo",
	publisher: "ash",
	version: "1.0.0",
	contributes: {
		grammars: [{ language: "demo", scopeName: "source.demo", path: "./syntaxes/demo.tmLanguage.json" }],
		debuggers: [{ type: "demo", label: "Demo Debug", debugAdapter: { program: "demo-adapter", args: ["--stdio", "", "$HOME"] } }, { type: "pure-debug", label: "Pure debug" }],
	},
});
const descriptor: ExtensionDescriptor = Object.freeze({
	id: "ash.demo",
	name: "demo",
	publisher: "ash",
	version: "1.0.0",
	displayName: "Demo",
	sourceKind: "builtIn",
	manifestJson: descriptorManifest,
	manifestSha256: digestText(descriptorManifest),
	packageSha256: `sha256:${"b".repeat(64)}`,
});

test("parses TextMate grammar contributions and normalizes package-relative paths", () => {
	const manifest = parseExtensionManifest(JSON.stringify({
		name: "demo",
		publisher: "ash",
		version: "1.0.0",
		contributes: {
			grammars: [{
				language: "demo",
				scopeName: "source.demo",
				path: "./syntaxes/demo.tmLanguage.json",
				injectTo: ["source.js"],
				tokenTypes: { "comment.demo": "comment" },
			}],
		},
	}), descriptor);

	assert.deepEqual(manifest.contributes.grammars[0], {
		language: "demo",
		scopeName: "source.demo",
		path: "syntaxes/demo.tmLanguage.json",
		injectTo: ["source.js"],
		tokenTypes: { "comment.demo": "comment" },
	});
});

test("fails closed for invalid or escaping grammar contributions", () => {
	assert.throws(() => parseExtensionManifest(JSON.stringify({
		name: "demo",
		publisher: "ash",
		version: "1.0.0",
		contributes: { grammars: [{ scopeName: "source.demo", path: "../outside.json" }] },
	}), descriptor));
	assert.throws(() => parseExtensionManifest(JSON.stringify({
		name: "demo",
		publisher: "ash",
		version: "1.0.0",
		contributes: { grammars: [{ scopeName: "source.demo", path: "grammar.json", tokenTypes: { "source.js": "invalid" } }] },
	}), descriptor), /invalid/);
});

test("parses declarative debugger contributions and rejects duplicate adapter ownership", () => {
	const manifest = parseExtensionManifest(JSON.stringify({
		name: "demo",
		publisher: "ash",
		version: "1.0.0",
		contributes: { debuggers: [{ type: "demo", label: "Demo Debug", debugAdapter: { program: "demo-adapter", args: ["--stdio"] } }] },
	}), descriptor);
	assert.deepEqual(manifest.contributes.debuggers, [{ type: "demo", label: "Demo Debug", program: "demo-adapter", arguments: ["--stdio"] }]);

	using registry = new ExtensionDebugAdapterRegistry();
	registry.replace([{ extensionId: "ash.demo", ...manifest.contributes.debuggers[0]! }]);
	assert.equal(registry.get("demo")?.program, "demo-adapter");
	assert.throws(() => registry.replace([{ extensionId: "ash.demo", ...manifest.contributes.debuggers[0]! }, { extensionId: "other.demo", ...manifest.contributes.debuggers[0]! }]), /both/);
});

test('debugger command mappings are validated and remain immutable across catalog generations', () => {
	const parse = (variables: unknown) => parseExtensionManifest(JSON.stringify({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { debuggers: [{ type: 'mapped', variables }] } }), descriptor);
	const contribution = parse({ PickProcess: 'ash.demo.pick' }).contributes.debuggers[0]!;
	assert.deepEqual(contribution.variables, { PickProcess: 'ash.demo.pick' });
	assert.equal(contribution.program, undefined);
	assert.equal(Object.isFrozen(contribution.variables), true);
	using registry = new ExtensionDebugAdapterRegistry();
	const variables = { PickProcess: 'ash.demo.pick' };
	registry.replace([{ extensionId: 'ash.demo', ...contribution, variables }]);
	variables.PickProcess = 'ash.demo.replacement';
	assert.deepEqual(registry.get('mapped')?.variables, { PickProcess: 'ash.demo.pick' });
	registry.replace([{ extensionId: 'ash.demo', ...contribution, variables }]);
	assert.deepEqual(registry.get('mapped')?.variables, { PickProcess: 'ash.demo.replacement' });
	registry.replace([]);
	assert.equal(registry.get('mapped'), undefined);
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	for (const invalid of [null, [], true, { PickProcess: '' }, { PickProcess: 1 }, { '': 'command' }, { PickProcess: 'bad\0command' }, Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`pick${index}`, 'command']))]) {
		assert.throws(() => parse(invalid), { message: '调试适配器“mapped”的命令变量映射无效。' });
	}
});

test("disposing a declarative Debug Adapter registry revokes its catalog", () => {
	const registry = new ExtensionDebugAdapterRegistry();
	const definition = Object.freeze({ extensionId: "ash.demo", type: "demo", label: "Demo", program: "demo-adapter", arguments: Object.freeze([]) });
	registry.replace([definition]);

	registry.dispose();

	assert.deepEqual(registry.definitions, []);
	assert.equal(registry.get("demo"), undefined);
	assert.throws(() => registry.replace([definition]), /disposed/);
});

test("preserves language, snippet, theme, and advanced TextMate metadata", () => {
	const manifest = parseExtensionManifest(JSON.stringify({
		name: "demo",
		publisher: "ash",
		version: "1.0.0",
		contributes: {
			languages: [{ id: "demo", extensions: [".demo"], firstLine: "^#!.*\\bdemo", configuration: "./language-configuration.json" }],
			snippets: [{ language: ["demo"], path: "./snippets/demo.json" }],
			themes: [{ label: "Demo Dark", path: "./themes/demo.json", uiTheme: "vs-dark" }],
			grammars: [{
				language: "demo",
				scopeName: "source.demo",
				path: "./syntaxes/demo.tmLanguage.json",
				embeddedLanguages: { "meta.embedded": "javascript" },
				tokenTypes: { "constant.demo": "string" },
				balancedBracketScopes: ["*"],
				unbalancedBracketScopes: ["string.quoted"],
			}],
		},
	}), descriptor);

	assert.deepEqual(manifest.contributes.languages[0], {
		id: "demo",
		aliases: [],
		extensions: [".demo"],
		filenames: [],
		filenamePatterns: [],
		mimetypes: [],
		firstLine: "^#!.*\\bdemo",
		configuration: "language-configuration.json",
	});
	assert.deepEqual(manifest.contributes.snippets[0], { language: ["demo"], path: "snippets/demo.json" });
	assert.deepEqual(manifest.contributes.themes[0], { label: "Demo Dark", path: "themes/demo.json", uiTheme: "vs-dark" });
	assert.deepEqual(manifest.contributes.grammars[0]!.embeddedLanguages, { "meta.embedded": "javascript" });
	assert.deepEqual(manifest.contributes.grammars[0]!.tokenTypes, { "constant.demo": "string" });
	assert.deepEqual(manifest.contributes.grammars[0]!.balancedBracketScopes, ["*"]);
});

test("validates extension theme catalogs", () => {

	const theme = parseExtensionTheme({
		semanticTokenColors: { "comment": { "foreground": "#6A9955", "fontStyle": "italic" } },
		colors: { "editor.foreground": "#D4D4D4" },
	}, "ash.demo:0", "ash.demo", "Demo Dark", "vs-dark", "theme test");
	using themes = new ExtensionThemeRegistry();
	themes.replace([theme]);
	assert.equal(themes.currentCatalog.themes[0]!.label, "Demo Dark");
	assert.deepEqual(themes.currentCatalog.themes[0]!.semanticTokenColors?.comment, { foreground: '#6A9955', fontStyle: 'italic' });
});

test("activates declarations without fetching legacy TextMate grammar resources", async () => {
	const catalog: ExtensionCatalog = Object.freeze({
		generation: 1,
		extensions: [descriptor],
		diagnostics: [],
	});
	const api: IExtensionApi = {
		list: async () => catalog,
		resources: new ExtensionResourceLoaderService(async request => {
			throw new Error(`Legacy grammar resource must not be read: ${request.path}`);
		}),
	};

	const service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	assert.equal("replace" in service.themes, false);
	assert.equal("replace" in service.fileTemplates, false);
	assert.equal("replace" in service.debugAdapters, false);
	assert.equal(Object.isFrozen(service.themes), true);
	assert.equal(Object.isFrozen(service.fileTemplates), true);
	assert.equal(Object.isFrozen(service.debugAdapters), true);

	await service.start();
	const factory = DebugAdapterFactoriesRegistry.get('demo');
	const previousCatalog = service.currentCatalog;
	let changes = 0;
	using change = service.onDidChange(() => changes++);
	await service.reload();
	assert.equal(DebugAdapterFactoriesRegistry.get('demo'), factory);
	assert.equal(service.currentCatalog, previousCatalog);
	assert.equal(changes, 0);

	assert.equal(service.currentCatalog.generation, catalog.generation);
	assert.equal(service.currentCatalog.extensions[0]?.id, descriptor.id);
	assert.equal(service.currentCatalog.extensions[0]?.packageSha256, descriptor.packageSha256);
	assert.equal("manifestJson" in service.currentCatalog.extensions[0]!, false);
	assert.equal(service.debugAdapters.get("demo")?.program, "demo-adapter");
	assert.equal(service.debugAdapters.get("pure-debug")?.label, "Pure debug");
	assert.equal(DebugAdapterFactoriesRegistry.get("pure-debug"), undefined);
	assert.deepEqual(DebugAdapterFactoriesRegistry.get("demo")?.createDebugAdapter?.(), { program: "demo-adapter", arguments: ["--stdio", "", "$HOME"] });
	service.dispose();
	assert.equal(DebugAdapterFactoriesRegistry.get("demo"), undefined);
});

test("disposes extension activation without leaking registrations", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	{
		using service = new AppServerExtensionService({ api: { list: async () => emptyCatalog(1), resources: new ExtensionResourceLoaderService(async () => new Uint8Array()) }, }, createEmptyTestLanguagePacks());
	}
	tracker.assertNoLeaks();
});

test("reads each generation-scoped resource once while preparing one catalog", async () => {
	const themedDescriptor = descriptorWithManifest({
		name: "demo",
		publisher: "ash",
		version: "1.0.0",
		contributes: {
			themes: [
				{ id: "first", label: "First", path: "themes/shared.json", uiTheme: "vs-dark" },
				{ id: "second", label: "Second", path: "themes/shared.json", uiTheme: "vs" },
			]
		},
	});
	let reads = 0;
	const api: IExtensionApi = {
		list: async () => Object.freeze({ generation: 7, extensions: Object.freeze([themedDescriptor]), diagnostics: Object.freeze([]) }),
		resources: new ExtensionResourceLoaderService(async () => { reads += 1; return new TextEncoder().encode('{"colors":{},"semanticTokenColors":{}}'); }),
	};
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());

	await service.start();

	assert.equal(reads, 1);
	assert.equal(service.themes.currentCatalog.themes.length, 2);
});

test('loads an extension theme include through its package resources', async () => {
	const themedDescriptor = descriptorWithManifest({
		name: 'demo', publisher: 'ash', version: '1.0.0',
		contributes: { themes: [{ id: 'inherited', label: 'Inherited', path: 'themes/child.json', uiTheme: 'vs-dark' }] },
	});
	const resources = new Map([
		['themes/child.json', JSON.stringify({ include: './base.json', colors: { 'editor.background': '#445566' }, semanticTokenColors: { "string": { "foreground": "#556677" } } })],
		['themes/base.json', JSON.stringify({ colors: { 'editor.background': '#112233', 'statusBar.background': '#223344' }, semanticTokenColors: { "comment": { "foreground": "#334455" } } })],
	]);
	const reads: string[] = [];
	const api: IExtensionApi = {
		list: async () => ({ generation: 1, extensions: [themedDescriptor], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(async request => {
			reads.push(request.path);
			return new TextEncoder().encode(resources.get(request.path)!);
		}),
	};
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	await service.start();
	const theme = service.themes.currentCatalog.themes[0]!;
	assert.deepEqual(reads, ['themes/child.json', 'themes/base.json']);
	assert.deepEqual(theme.colors, { 'editor.background': '#445566', 'statusBar.background': '#223344' });
	assert.deepEqual(theme.semanticTokenColors, { comment: { foreground: '#334455' }, string: { foreground: '#556677' } });
	assert.equal(theme.colors['statusBar.background'], '#223344');
});

test('rejects retired extension token themes without reading syntax resources', async () => {
	const { loadExtensionTheme } = await import('../../common/extensionTheme.js');
	const reads: string[] = [];
	await assert.rejects(loadExtensionTheme(async path => {
		reads.push(path);
		return new TextEncoder().encode(JSON.stringify({ tokenColors: './syntax.tmTheme' }));
	}, 'ash.demo', { id: 'old', label: 'Old', path: 'themes/main.json', uiTheme: 'vs-dark' }, 0), /Invalid color theme/);
	assert.deepEqual(reads, ['themes/main.json']);
});

test("rejects a catalog whose canonical manifest digest does not match", async () => {
	const api: IExtensionApi = {
		list: async () => Object.freeze({ generation: 1, extensions: Object.freeze([Object.freeze({ ...descriptor, manifestSha256: `sha256:${"0".repeat(64)}` })]), diagnostics: Object.freeze([]) }),
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());

	await assert.rejects(service.start(), /manifest digest/);
	assert.equal(service.currentCatalog.generation, 0);
});

test("coalesces concurrent reload requests into one queued follow-up refresh", async () => {
	const first = deferred<ExtensionCatalog>();
	let listCalls = 0;
	const api: IExtensionApi = {
		list: () => {
			listCalls += 1;
			return listCalls === 1 ? first.promise : Promise.resolve(emptyCatalog(2));
		},
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());

	const starting = service.start();
	const firstQueued = service.reload();
	const secondQueued = service.reload();
	assert.equal(starting, firstQueued);
	assert.equal(starting, secondQueued);
	assert.equal(listCalls, 1);

	first.resolve(emptyCatalog(1));
	await starting;

	assert.equal(listCalls, 2);
	assert.equal(service.currentCatalog.generation, 2);
});

test('a superseded failed reload does not reject a caller after the latest catalog commits', async () => {
	let rejectFirst: (error: Error) => void = () => { throw new Error('First catalog request was not started'); };
	let requests = 0;
	const api: IExtensionApi = {
		list: () => ++requests === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; }) : Promise.resolve(emptyCatalog(2)),
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	const failures: unknown[] = [];
	using listener = service.onDidFail(failure => failures.push(failure.error));
	const starting = service.start();
	assert.equal(service.reload(), starting);
	rejectFirst(new Error('Catalog generation changed during a resource read'));
	await starting;
	assert.deepEqual({ requests, generation: service.currentCatalog.generation, failures }, { requests: 2, generation: 2, failures: [] });
});

test('queued reloads report the final failure and retain the last committed catalog', async () => {
	let rejectFirst: (error: Error) => void = () => { throw new Error('First reload was not started'); };
	let requests = 0;
	const finalFailure = new Error('Latest resource is unavailable');
	const api: IExtensionApi = {
		list: () => {
			requests++;
			if (requests === 1) return Promise.resolve(emptyCatalog(1));
			if (requests === 2) return new Promise((_resolve, reject) => { rejectFirst = reject; });
			return Promise.reject(finalFailure);
		},
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	await service.start();
	const failures: unknown[] = [];
	using listener = service.onDidFail(failure => failures.push(failure.error));
	const loading = service.reload();
	assert.equal(service.reload(), loading);
	rejectFirst(new Error('Superseded generation'));
	await assert.rejects(loading, error => error === finalFailure);
	assert.deepEqual({ requests, generation: service.currentCatalog.generation, failures }, { requests: 3, generation: 1, failures: [finalFailure] });
});

test("reloads declarations for Plugin activation and Extensions installation changes", async () => {
	let generation = 0;
	let listener: ((event: ServerNotification) => void) | undefined;
	const eventApi: IServerEventApi = {
		subscribe(next) {
			listener = next;
			return { dispose: () => { listener = undefined; } };
		},
	};
	const api: IExtensionApi = {
		list: async () => emptyCatalog(++generation),
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};
	using service = new AppServerExtensionService({ api, eventApi, }, createEmptyTestLanguagePacks());
	await service.start();
	const refreshed = deferred<WorkbenchExtensionCatalog>();
	using changed = service.onDidChange(catalog => {
		if (catalog.generation === 2) refreshed.resolve(catalog);
	});

	listener?.({ method: "plugin/changed", params: { revision: 2, activationGeneration: 2 } });
	const catalog = await refreshed.promise;

	assert.equal(catalog.generation, 2);
	const installed = deferred<WorkbenchExtensionCatalog>();
	using installedChange = service.onDidChange(next => { if (next.generation === 3) installed.resolve(next); });
	listener?.({ method: 'extensions/changed', params: { instanceId: 'manager-1', generation: 2 } });
	assert.equal((await installed.promise).generation, 3);
	listener?.({ method: 'extensions/changed', params: { instanceId: 'manager-1', generation: 2 } });
	listener?.({ method: 'extensions/changed', params: { instanceId: 'manager-1', generation: 1 } });
	assert.equal(generation, 3, 'replayed or older generations do not reinstall contributions');
	const restarted = deferred<WorkbenchExtensionCatalog>();
	using restartChange = service.onDidChange(next => { if (next.generation === 4) restarted.resolve(next); });
	listener?.({ method: 'extensions/changed', params: { instanceId: 'manager-2', generation: 1 } });
	assert.equal((await restarted.promise).generation, 4, 'a new manager instance can start at a lower generation');
});

test("dispose suppresses a queued reload and ignores the in-flight result", async () => {
	const first = deferred<ExtensionCatalog>();
	let listCalls = 0;
	const api: IExtensionApi = {
		list: () => {
			listCalls += 1;
			return first.promise;
		},
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};
	const service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	const starting = service.start();
	service.reload();
	service.dispose();

	first.resolve(emptyCatalog(1));
	await assert.doesNotReject(starting);
	assert.equal(listCalls, 1);
});

test("preserves the last active catalog when refreshed theme materialization fails", async () => {
	const extension = descriptorWithManifest({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { themes: [{ id: 'demo', label: 'Demo', path: 'theme.json', uiTheme: 'vs-dark' }] } });
	let generation = 1;
	const api: IExtensionApi = {
		list: async () => ({ generation, extensions: [extension], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(async () => new TextEncoder().encode(generation === 1 ? '{"colors":{},"semanticTokenColors":{}}' : 'invalid theme')),
	};
	using service = new AppServerExtensionService({ api }, createEmptyTestLanguagePacks());
	await service.start();
	const previousCatalog = service.currentCatalog;
	const previousThemes = service.themes.currentCatalog;
	generation++;
	await assert.rejects(service.reload());
	assert.equal(service.currentCatalog, previousCatalog);
	assert.equal(service.themes.currentCatalog, previousThemes);
});

test("publishes one coherent contribution generation to registry listeners", async () => {
	const catalog: ExtensionCatalog = Object.freeze({
		generation: 3,
		extensions: Object.freeze([descriptorWithManifest({
			name: "demo",
			publisher: "ash",
			version: "1.0.0",
			contributes: {
				languages: [{ id: "demo", extensions: [".demo"] }],
				themes: [{ id: "dark", label: "Demo Dark", path: "themes/dark.json", uiTheme: "vs-dark" }],
				debuggers: [{ type: "demo", label: "Demo Debug", debugAdapter: { program: "demo-adapter" } }],
			},
		})]),
		diagnostics: Object.freeze([]),
	});
	const api: IExtensionApi = {
		list: async () => catalog,
		resources: new ExtensionResourceLoaderService(async () => new TextEncoder().encode('{"colors":{},"semanticTokenColors":{}}')),
	};
	using languageService = new LanguageService();
	using languages = new LanguageFeaturesService();
	using service = new AppServerExtensionService({ api, languageService, languageConfigurationService: languages.languageConfigurationService }, createEmptyTestLanguagePacks());
	const observations: Array<{ readonly themeCount: number; readonly adapterCount: number; readonly generation: number; }> = [];
	using listener = languageService.languages.onDidChange(() => observations.push({
		themeCount: service.themes.currentCatalog.themes.length,
		adapterCount: service.debugAdapters.definitions.length,
		generation: service.currentCatalog.generation,
	}));

	await service.start();

	assert.deepEqual(observations, [{ themeCount: 1, adapterCount: 1, generation: 3 }]);
});

test("resolves extension language first-line patterns after file content is available", () => {
	using languages = new LanguageService();
	using registration = languages.registerLanguage({ id: "demo", firstLine: "^#!.*\\bdemo" }, { priority: 100 });

	assert.equal(languages.resolveLanguageId({ resource: URI.file("C:\\workspace\\script"), firstLine: "#!/usr/bin/env demo" }), "demo");
	assert.equal(languages.resolveLanguageId({ resource: URI.file("C:\\workspace\\script"), firstLine: "#!/usr/bin/env python" }), undefined);
});

test("treats an in-flight load cancelled by disposal as normal shutdown", async () => {
	let rejectList: ((error: Error) => void) | undefined;
	const api: IExtensionApi = {
		list: () => new Promise((_resolve, reject) => { rejectList = reject; }),
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};

	const service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	const failures: unknown[] = [];
	using listener = service.onDidFail(failure => failures.push(failure.error));

	const starting = service.start();
	service.dispose();
	rejectList?.(new Error("transport disposed"));

	await assert.doesNotReject(starting);
	assert.deepEqual(failures, []);
});

function catalogWithGeneration(generation: number): ExtensionCatalog {
	return Object.freeze({ generation, extensions: Object.freeze([descriptor]), diagnostics: Object.freeze([]) });
}

test('loads icon manifests and fonts through generation-bound resources and revokes them on disposal', async () => {
	const manifest = JSON.parse(await readFile('extensions/theme-seti/package.json', 'utf8'));
	const entry = descriptorWithManifest({ ...manifest, name: 'demo' });
	let generation = 1;
	let fail = false;
	const requests: string[] = [];
	const api: IExtensionApi = {
		list: async () => ({ generation, extensions: [entry], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(async request => {
			assert.equal(request.generation, generation);
			requests.push(request.path);
			if (fail && request.path.endsWith('.woff')) { throw new Error('Font unavailable'); }
			return readFile('extensions/theme-seti/' + request.path);
		}),
	};
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	await service.start();
	const theme = WorkbenchFileIconThemesRegistry.getThemes().find(theme => theme.id === 'vs-seti');
	assert.ok(theme?.resolveFileIcon(['file-icon', 'typescript-lang-file-icon'], ColorScheme.Dark)?.character);
	assert.deepEqual(requests, ['icons/vs-seti-icon-theme.json', 'icons/seti.woff']);
	generation++;
	fail = true;
	await assert.rejects(service.reload(), /Font unavailable/);
	assert.equal(WorkbenchFileIconThemesRegistry.getThemes().find(theme => theme.id === 'vs-seti'), theme);
	assert.equal(service.currentCatalog.generation, 1);
	service.dispose();
	assert.equal(WorkbenchFileIconThemesRegistry.getThemes().find(theme => theme.id === 'vs-seti'), undefined);
});

test('reconnection restores file icons after interrupted activation and releases its state listener', async () => {
	const manifest = JSON.parse(await readFile('extensions/theme-seti/package.json', 'utf8'));
	const entry = descriptorWithManifest({ ...manifest, name: 'demo' });
	using states = new Emitter<AppServerConnectionState>();
	let incarnation = 1;
	let interruptFont = true;
	let listRequests = 0;
	let releasedResources = 0;
	const resources = new Map<string, Buffer>();
	const connection = {
		onStateChange: states.event,
		request: async ({ method }: { method: string; }, params: { path: string; }) => {
			if (method === 'extensions/list') {
				listRequests++;
				return { generation: 17, extensions: [entry], diagnostics: [] };
			}
			assert.equal(method, 'extensions/resource/open');
			if (interruptFont && params.path.endsWith('.woff')) {
				interruptFont = false;
				states.fire('crashed');
				throw new Error('App Server connection interrupted');
			}
			const bytes = await readFile('extensions/theme-seti/' + params.path);
			const resourceId = `resource_${resources.size}`;
			resources.set(resourceId, bytes);
			return { resource: { resourceId, size: bytes.length, mimeType: 'application/octet-stream', sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}` } };
		},
	} as unknown as AppServerProtocolClient;
	const resourceApi: IResourceApi = {
		get connectionGeneration() { return incarnation; },
		metadata: async () => { throw new Error('Unexpected metadata request'); },
		read: async request => {
			const bytes = resources.get(request.resourceId)!;
			const chunk = bytes.subarray(request.offset, request.offset + request.maxBytes);
			return { resourceId: request.resourceId, offset: request.offset, decodedLength: chunk.length, dataBase64: chunk.toString('base64'), eof: request.offset + chunk.length === bytes.length };
		},
		release: async () => { releasedResources++; },
	};
	const api = createAppServerExtensionApi(connection, resourceApi);
	using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
	await assert.rejects(service.start(), /connection interrupted/);
	assert.equal(WorkbenchFileIconThemesRegistry.getThemes().find(theme => theme.id === 'vs-seti'), undefined);
	assert.equal(listRequests, 1);
	assert.equal(states.hasListeners(), true);
	states.fire('starting');
	states.fire('initializing');
	assert.equal(listRequests, 1);
	incarnation++;
	let restored!: () => void;
	const activation = new Promise<void>(resolve => { restored = resolve; });
	using activationListener = service.onDidChange(() => restored());
	states.fire('ready');
	await activation;
	const theme = WorkbenchFileIconThemesRegistry.getThemes().find(theme => theme.id === 'vs-seti');
	assert.ok(theme?.resolveFileIcon(['file-icon', 'typescript-lang-file-icon'], ColorScheme.Light)?.character);
	assert.equal(listRequests, 2);
	assert.equal(service.currentCatalog.generation, 2);
	assert.equal(releasedResources, 3);
	service.dispose();
	assert.equal(states.hasListeners(), false);
	states.fire('ready');
	assert.equal(listRequests, 2);
});

function descriptorWithManifest(manifest: unknown): ExtensionDescriptor {
	const manifestJson = JSON.stringify(manifest);
	return Object.freeze({ ...descriptor, manifestJson, manifestSha256: digestText(manifestJson) });
}

function digestText(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function emptyCatalog(generation: number): ExtensionCatalog {
	return Object.freeze({ generation, extensions: Object.freeze([]), diagnostics: Object.freeze([]) });
}


function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}

test('extension theme contributions activate together, retain the last valid catalog, and revoke on removal', async () => {
	const { Colors } = await import('../../../../../platform/theme/common/colorRegistry.js');
	const { getIconRegistry, getIconDefinition } = await import('../../../../../platform/theme/common/iconRegistry.js');
	const { getTokenClassificationRegistry } = await import('../../../../../platform/theme/common/tokenClassificationRegistry.js');
	const { parseUserColorTheme } = await import('../../../themes/common/colorThemeData.js');
	let generation = 1;
	let contributed = true;
	let invalid = false;
	const manifest = () => descriptorWithManifest({
		name: 'demo', publisher: 'ash', version: '1.0.0', contributes: {
			colors: [{ id: 'test.extensionAccent', description: 'Extension accent', defaults: { light: '#123456', dark: '#654321', highContrast: '#fedcba', highContrastLight: '#aabbcc' } }],
			semanticTokenTypes: [{ id: 'testCustomFunction', description: 'Custom function', superType: invalid ? 'missingType' : 'function' }],
			semanticTokenModifiers: [{ id: 'testCustomModifier', description: 'Custom modifier' }],

			icons: { 'test-extension-alias': { description: 'Extension icon', default: 'add' } },
		}
	});
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: contributed ? [manifest()] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('Unexpected resource'); }) }, }, createEmptyTestLanguagePacks());
	await service.start();
	for (const [type, expected] of [['hcDark', '#fedcba'], ['hcLight', '#aabbcc']]) {
		const contrast = parseUserColorTheme(JSON.stringify({ name: 'Extension contrast', type, colors: {} }));
		assert.equal(contrast.getColorCss('test.extensionAccent'), expected);
	}
	const themed = parseUserColorTheme(JSON.stringify({
		name: 'Extension mappings', colors: { 'test.extensionAccent': '#abcdef' },
		semanticTokenColors: { function: { foreground: '#112233', fontStyle: 'italic', bold: true } },
	}));
	const style = themed.getTokenStyleMetadata('testCustomFunction', ['testCustomModifier'], 'typescript')!;
	assert.equal(themed.tokenColorMap[style.foreground!], '#112233');
	assert.equal(style.bold, true);
	assert.equal(style.italic, true);
	assert.equal(themed.getColorCss('test.extensionAccent'), '#abcdef');
	assert.ok(getIconDefinition({ id: 'test-extension-alias' }));
	invalid = true; generation++;
	await assert.rejects(service.reload(), /Unknown semantic super type/);
	assert.equal(service.currentCatalog.generation, 1);
	assert.ok(getTokenClassificationRegistry().getTokenTypes().some(type => type.id === 'testCustomFunction'));
	assert.ok(getIconRegistry().getIcon('test-extension-alias'));
	contributed = false; generation++;
	await service.reload();
	assert.equal(themed.getColor('test.extensionAccent'), undefined);
	assert.equal(Colors.getColors().some(color => color.id === 'test.extensionAccent'), false);
	assert.equal(getTokenClassificationRegistry().getTokenTypes().some(type => type.id === 'testCustomFunction'), false);
	assert.equal(getIconRegistry().getIcon('test-extension-alias'), undefined);
});

test('the packaged browser catalog activates Markdown grammar and configuration as one generation', async () => {
	const bundle = JSON.parse(await readFile('.build/builtin/fixture.json', 'utf8'));
	using languages = new LanguageFeaturesService();
	using languageService = new LanguageService();
	using service = new AppServerExtensionService({ api: { list: async () => bundle.catalog, resources: new ExtensionResourceLoaderService(async request => Uint8Array.from(Buffer.from(bundle.resources[request.extensionId][request.path], 'base64'))) }, languageService, languageConfigurationService: languages.languageConfigurationService }, createEmptyTestLanguagePacks());
	using snippets = new SnippetsService(service);
	await service.start();
	assert.equal(languageService.guessLanguageIdByFilepathOrFirstLine(URI.file('/notes/draft.md')), 'markdown');
	assert.equal(languageService.createByMimeType('text/markdown').languageId, 'markdown');
});

test('extension configuration activates in the canonical owner and rolls back other contributions on schema failure', async () => {
	let generation = 1;
	let present = true;
	let invalid = false;
	const manifest = (): ExtensionDescriptor => descriptorWithManifest({
		name: 'demo', publisher: 'ash', version: '1.0.0', contributes: {
			configuration: { title: 'Extension configuration', properties: { 'extensionConfiguration.value': { type: 'string', default: 'default', scope: 'language-overridable' }, 'extensionConfiguration.count': { type: 'integer', default: invalid ? 'invalid' : generation } } },
			problemMatchers: [{ name: 'extension-configuration-matcher', owner: invalid ? 'changed' : 'original', pattern: { regexp: '^(.+):(\\d+) (.+)$', file: 1, line: 2, message: 3 } }],
		}
	});
	const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
	const source = '{"extensionConfiguration.value":"user value"}';
	using configuration = new WorkbenchConfigurationService({ source: source });
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: present ? [manifest()] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('No contribution resources'); }) }, }, createEmptyTestLanguagePacks());
	await service.start();
	assert.deepEqual({ value: configuration.getValue('extensionConfiguration.value'), count: configuration.getValue('extensionConfiguration.count') }, { value: 'user value', count: 1 });
	using locale = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	invalid = true; generation++;
	await assert.rejects(service.reload(), { message: '设置“extensionConfiguration.count”不符合其声明的架构。' });
	assert.throws(() => registry.updateConfigurations({ add: [{ properties: { 'extensionConfiguration.count': { type: 'integer', default: 1 } } }], remove: [] }), { message: '扩展贡献的设置“extensionConfiguration.count”无效或重复。' });
	assert.throws(() => parseExtensionManifest(JSON.stringify({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { configuration: Array.from({ length: 65 }, () => ({ properties: {} })) } }), manifest()), { message: '扩展最多可贡献 64 个配置部分。' });
	assert.deepEqual({ count: configuration.getValue('extensionConfiguration.count'), generation: service.currentCatalog.generation, matcher: parseProblemMatchers(['$extension-configuration-matcher'])[0].owner }, { count: 1, generation: 1, matcher: 'original' });
	invalid = false; present = false; generation++;
	await service.reload();
	assert.equal(configuration.getValue('extensionConfiguration.value'), undefined);
	assert.equal(registry.owns('extensionConfiguration.count'), false);
	assert.equal((await configuration.read()).source, source);
	present = true; generation++;
	await service.reload();
	assert.equal(configuration.getValue('extensionConfiguration.count'), 4);
	service.dispose();
	assert.equal(registry.owns('extensionConfiguration.count'), false);
});

test('declarative extension problem contributions activate, roll back failed reloads, and retire on removal', async () => {
	let generation = 1;
	let present = true;
	let invalid = false;
	const manifest = (): ExtensionDescriptor => descriptorWithManifest({
		name: 'demo', publisher: 'ash', version: '1.0.0', contributes: {
			problemPatterns: [{ name: 'extension-service-pattern', regexp: '^(.+):(\\d+):(\\d+) (.+)$', file: 1, line: 2, column: 3, message: 4 }],
			problemMatchers: [{ name: 'extension-service-matcher', owner: 'extension-service', pattern: invalid ? '$missing-pattern' : '$extension-service-pattern', background: { beginsPattern: '^BUILD$', endsPattern: '^READY$' } }],
		},
	});
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: present ? [manifest()] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('Matcher declarations have no resources'); }) }, }, createEmptyTestLanguagePacks());
	await service.start();
	using markers = new MarkerService();
	using collector = new WatchingProblemCollector(parseProblemMatchers(['$extension-service-matcher']), URI.file('/workspace'), markers, 'extension-service', () => false);
	collector.accept(new TextEncoder().encode('BUILD\napp.ts:1:2 extension issue\nREADY\n'));
	assert.equal(collector.isReady, true);
	assert.equal(markers.read()[0].message, 'extension issue');
	invalid = true;
	generation++;
	await assert.rejects(service.reload(), /Unknown problem pattern '\$missing-pattern'/);
	assert.equal(service.currentCatalog.generation, 1);
	assert.equal(parseProblemMatchers(['$extension-service-matcher'])[0].owner, 'extension-service');
	invalid = false;
	present = false;
	generation++;
	await service.reload();
	assert.throws(() => parseProblemMatchers(['$extension-service-matcher']), /Unknown problem matcher/);
	present = true;
	generation++;
	await service.reload();
	service.dispose();
	assert.throws(() => parseProblemMatchers(['$extension-service-matcher']), /Unknown problem matcher/);
});


for (const [targetPlatform, extensionLocation, selected, expectedProgram] of [
	['linux-x64', 'file:///installed/extension', 'linux', '/installed/extension/linux-adapter.js'],
	['darwin-arm64', 'file:///installed/extension', 'osx', '/installed/extension/osx-adapter.js'],
	['win32-ia32', 'file:///C:/installed/extension', 'winx86', 'C:\\installed\\extension\\winx86-adapter.js'],
	['win32-x64', 'file://server/share/extension', 'windows', '\\\\server\\share\\extension\\windows-adapter.js'],
] as const) {
	test(`standard declarative Debug executable uses package paths and the ${targetPlatform} execution host`, async () => {
		const declaration = {
			type: 'standard', runtime: 'runtime-command', runtimeArgs: ['--runtime', '', '$HOME'], program: 'base-adapter.js', args: ['base'],
			linux: { program: 'linux-adapter.js', args: ['linux', '', '$HOME'] },
			osx: { program: 'osx-adapter.js', args: ['osx', '', '$HOME'] },
			windows: { program: 'windows-adapter.js', args: ['windows', '', '$HOME'] },
			winx86: { program: 'winx86-adapter.js', args: ['winx86', '', '$HOME'] },
		};
		const manifestJson = JSON.stringify({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { debuggers: [declaration] } });
		let present = true;
		let generation = 1;
		using service = new AppServerExtensionService({
			api: { list: async () => normalizeExtensionCatalog({ generation, extensions: present ? [{ ...descriptor, extensionLocation, targetPlatform, manifestJson, manifestSha256: digestText(manifestJson) }] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw Error('Debugger metadata must not read a resource'); }) },

		}, createEmptyTestLanguagePacks());
		await service.reload();
		assert.deepEqual(DebugAdapterFactoriesRegistry.get('standard')?.createDebugAdapter?.(), {
			program: 'runtime-command', arguments: ['--runtime', '', '$HOME', expectedProgram, selected, '', '$HOME'],
		});
		assert.equal(service.debugAdapters.get('standard')?.label, 'standard');
		present = false;
		generation++;
		await service.reload();
		assert.equal(DebugAdapterFactoriesRegistry.get('standard'), undefined);
	});
}

test('relative Debug runtime paths use the installed package and missing host facts are localized', () => {
	using localization = toDisposable(resetNlsResolver);
	initializeTestLocalization('zh-CN');
	const declaration = { type: 'standard', program: './adapter.js', runtime: './bin/runtime', runtimeArgs: ['-r'], args: [''] };
	const manifestJson = JSON.stringify({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { debuggers: [declaration] } });
	const manifest = parseExtensionManifest(manifestJson, { ...descriptor, extensionLocation: 'file:///installed/extension', targetPlatform: 'linux-x64' });
	assert.deepEqual(manifest.contributes.debuggers, [{ type: 'standard', label: 'standard', program: '/installed/extension/bin/runtime', arguments: ['-r', '/installed/extension/adapter.js', ''] }]);
	assert.throws(() => parseExtensionManifest(manifestJson, descriptor), /无法获取调试适配器“standard”的安装位置/);
	const platformManifest = JSON.stringify({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { debuggers: [{ type: 'standard', linux: { program: 'adapter' } }] } });
	assert.throws(() => parseExtensionManifest(platformManifest, descriptor), /无法获取调试适配器“standard”的执行平台/);
});


test('catalog refresh preserves an unchanged declarative Debug owner and retires a changed package', async () => {
	let generation = 1;
	let entry = descriptor;
	let present = true;
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: present ? [entry] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => new TextEncoder().encode('{"scopeName":"source.demo","patterns":[]}')) }, }, createEmptyTestLanguagePacks());
	await service.start();
	const original = DebugAdapterFactoriesRegistry.get('demo');
	assert.ok(original);
	generation++;
	await service.reload();
	assert.equal(DebugAdapterFactoriesRegistry.get('demo'), original, 'scan revision changes do not revoke an unchanged package');
	entry = { ...descriptor, packageSha256: `sha256:${'c'.repeat(64)}` };
	generation++;
	await service.reload();
	assert.notEqual(DebugAdapterFactoriesRegistry.get('demo'), original, 'changed package content retires the executable owner');
	present = false;
	generation++;
	await service.reload();
	assert.equal(DebugAdapterFactoriesRegistry.get('demo'), undefined);
});

test('profile disablement retires declarative settings and welcome content without a catalog mutation', async () => {
	const dom = new JSDOM('', { url: 'https://ash.test' });
	try {
		using storage = new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'test', flushInterval: 0 });
		using enablement = new GlobalExtensionEnablementService(storage);
		const entry = descriptorWithManifest({
			name: 'demo', publisher: 'ash', version: '1.0.0', contributes: {
				configuration: { title: 'Provider', properties: { 'test.enablement.option': { type: 'boolean', default: false } } },
				viewsWelcome: [{ view: 'test.enablement.scm', contents: 'Enablement welcome' }],
			}
		});
		const api = withEnabledBuiltInExtensions({ list: async () => ({ generation: 1, diagnostics: [], extensions: [entry] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('No contribution resource'); }) }, enablement);
		using service = new AppServerExtensionService({ api, }, createEmptyTestLanguagePacks());
		const registry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);
		await service.start();
		assert.ok(registry.getConfiguration('test.enablement.option'));
		assert.deepEqual(ViewsRegistry.getViewWelcomeContent('test.enablement.scm').map(value => value.content), ['Enablement welcome']);
		await enablement.disableExtension({ id: entry.id });
		await service.reload();
		assert.equal(service.currentCatalog.extensions.length, 0);
		assert.equal(registry.getConfiguration('test.enablement.option'), undefined);
		assert.deepEqual(ViewsRegistry.getViewWelcomeContent('test.enablement.scm'), []);
		await enablement.enableExtension({ id: entry.id });
		await service.reload();
		assert.deepEqual(service.currentCatalog.extensions.map(value => value.id), [entry.id]);
		assert.ok(registry.getConfiguration('test.enablement.option'));
	} finally { dom.window.close(); }
});

test('speech provider declarations remain bounded immutable metadata in the original manifest owner', () => {
	const manifest = parseExtensionManifest(JSON.stringify({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { speechProviders: [{ name: 'acme.speech', description: 'Recognition' }] } }), descriptor);
	assert.deepEqual(manifest.contributes.speechProviders, [{ name: 'acme.speech', description: 'Recognition' }]);
	assert.equal(Object.isFrozen(manifest.contributes.speechProviders[0]), true);
	for (const providers of [[{ name: '' }], [{ name: 'a', model: 'untrusted' }], [{ name: 'same' }, { name: 'same' }], [{ name: 'a', description: 1 }]]) {
		assert.throws(() => parseExtensionManifest(JSON.stringify({ name: 'demo', publisher: 'ash', version: '1.0.0', contributes: { speechProviders: providers } }), descriptor), /Invalid speech provider contribution/);
	}
});


test('built-in language associations agree with ash-language on the shared conformance corpus', async () => {
	using languages = new LanguageService();
	for (const directory of (await readdir('extensions')).sort()) {
		let raw;
		try { raw = JSON.parse(await readFile(`extensions/${directory}/package.json`, 'utf8')); }
		catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
		if (!raw.contributes?.languages) continue;
		// Use the product manifest boundary, including normalization of case-variant suffixes.
		const descriptor = { id: `${raw.publisher}.${raw.name}`, name: raw.name, publisher: raw.publisher, version: raw.version };
		const manifest = parseExtensionManifest(JSON.stringify({ name: raw.name, publisher: raw.publisher, version: raw.version, contributes: { languages: raw.contributes.languages } }), descriptor);
		for (const language of manifest.contributes.languages) {
			languages.registerLanguage({ id: language.id, extensions: language.extensions, filenames: language.filenames, filenamePatterns: language.filenamePatterns, firstLine: language.firstLine });
		}
	}
	const cases: { path: string; firstLine?: string; language: string; }[] = JSON.parse(await readFile('test/fixtures/languages/associations.json', 'utf8'));
	for (const entry of cases) {
		const path = entry.path.startsWith('/') || /^[a-z]:/i.test(entry.path) ? entry.path : `/repo/${entry.path}`;
		assert.equal(languages.resolveLanguageId({ resource: URI.file(path), firstLine: entry.firstLine }) ?? 'plaintext', entry.language, entry.path);
	}
});

test('common project language packages register resources and localize English and Chinese labels', async () => {
	using localization = toDisposable(resetNlsResolver);
	const packages = ['bat', 'cpp', 'csharp', 'java', 'powershell', 'docker', 'make', 'dotenv', 'lua', 'ruby', 'php', 'swift', 'dart', 'log', 'json', 'r', 'julia', 'clojure', 'groovy', 'coffeescript', 'perl'];
	const extensions = await Promise.all(packages.map(async directory => {
		const manifestJson = await readFile(`extensions/${directory}/package.json`, 'utf8');
		const manifest = JSON.parse(manifestJson);
		return { ...descriptor, id: `${manifest.publisher}.${manifest.name}`, name: manifest.name, publisher: manifest.publisher, version: manifest.version, manifestJson, manifestSha256: digestText(manifestJson) };
	}));
	for (const locale of ['en', 'zh-CN']) {
		initializeTestLocalization(locale);
		const api: IExtensionApi = {
			list: async () => ({ generation: 1, extensions, diagnostics: [] }),
			resources: new ExtensionResourceLoaderService(request => readFile(`extensions/${request.extensionId.slice('ash.'.length)}/${request.path}`)),
		};
		using languageService = new LanguageService();
		using languages = new LanguageFeaturesService();
		const languagePacks = createEmptyTestLanguagePacks();
		using service = new AppServerExtensionService({ api, languageService, languageConfigurationService: languages.languageConfigurationService }, languagePacks);
		using snippets = new SnippetsService(service);
		await service.start();
		assert.equal(service.currentCatalog.extensions.length, packages.length);
		const labels = new MainThreadLocalization(languagePacks, api);
		for (const extension of extensions) {
			const manifest = JSON.parse(await labels.localizeManifest(extension.id, extension.manifestJson, 1));
			if (extension.name === 'json') {
				assert.deepEqual(manifest.contributes.languages.find((language: { id: string; }) => language.id === 'snippets').aliases, [locale === 'en' ? 'Code Snippets' : '代码片段', 'snippets']);
			} else {
				assert.match(manifest.displayName, locale === 'en' ? /(?:Language|File) Support$/ : /(?:语言|文件)支持$/);
			}
		}
	}
});
