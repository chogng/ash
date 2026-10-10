import { normalizeExtensionCatalog } from '../../../../../platform/extensions/common/extensionApi.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { initializeTestLocalization } from '../../../localization/test/common/localizationTestUtils.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "mocha";
import { readFile } from 'node:fs/promises';
import { ColorScheme } from '../../../../../platform/theme/common/theme.js';
import { WorkbenchFileIconThemesRegistry } from '../../../themes/common/themeExtensionPoints.js';
import { DisposableTracker, installDisposableTracker, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { ExtensionCatalog, ExtensionDescriptor, IExtensionApi } from "../../../../../platform/extensions/common/extensionApi.js";
import type { IServerEventApi } from "../../../../../platform/agentHost/common/appServerApi.js";
import type { ServerNotification } from "../../../../../../../.build/protocol/typescript/index.js";
import { AppServerExtensionService } from "../../browser/appServerExtensionService.js";
import { parseExtensionManifest, type ExtensionCatalog as WorkbenchExtensionCatalog } from "../../common/extensionService.js";
import { parseJsonc } from "../../common/jsonc.js";
import { createExtensionSnippetProvider, parseExtensionSnippetFile } from "../../common/extensionSnippetProvider.js";
import { ExtensionThemeRegistry, parseExtensionTheme } from "../../common/extensionTheme.js";
import { ExtensionDebugAdapterRegistry } from "../../common/extensionDebugAdapter.js";
import { DebugAdapterFactoriesRegistry } from "../../../debug/common/debugAdapterFactory.js";
import { parseProblemMatchers } from '../../../../contrib/tasks/common/problemMatcher.js';
import { WatchingProblemCollector } from '../../../../contrib/tasks/common/problemCollectors.js';
import { MarkerService } from '../../../../../platform/markers/common/markers.js';
import type { ITextMateService } from "../../../textMate/common/textMateService.js";
import type { TextMateGrammarDefinition } from "../../../textMate/common/textMateGrammarRegistry.js";
import { TextMateGrammarService } from "../../../textMate/common/textMateGrammarService.js";
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { LanguageCompletionTriggerKind } from '../../../../../editor/common/languages.js';
import { TextModel } from "../../../../../editor/common/model/textModel.js";

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

test("extension snippets use one-based editor positions and ranges", async () => {
	const provider = createExtensionSnippetProvider("ash.demo.snippets", "typescript", [{
		name: "log",
		prefixes: ["log"],
		body: "console.log($1)",
	}]);
	using model = new TextModel("first line\n  lo");
	const position = new Position(2, 5);
	const result = await provider.provideCompletions({
		requestId: 1,
		languageId: "typescript",
		position,
		context: { kind: LanguageCompletionTriggerKind.Invoke },
		snapshot: model.createVersionedSnapshot(),
	}, new AbortController().signal);

	assert.deepEqual(result?.items[0]?.range, new Range(2, 3, 2, 5));
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

test("parses JSONC snippet files and validates extension theme catalogs", () => {
	const snippets = parseExtensionSnippetFile(parseJsonc(`{
    // comment
    "for": { "prefix": ["for", "loop"], "body": ["for (const item of items) {", "  $0", "}"], },
  }`, "snippet test"), "snippet test");
	assert.deepEqual(snippets[0], {
		name: "for",
		prefixes: ["for", "loop"],
		body: "for (const item of items) {\n  $0\n}",
	});

	const theme = parseExtensionTheme({
		tokenColors: [{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6A9955", fontStyle: "italic" } }],
		colors: { "editor.foreground": "#D4D4D4" },
	}, "ash.demo:0", "ash.demo", "Demo Dark", "vs-dark", "theme test");
	using themes = new ExtensionThemeRegistry();
	themes.replace([theme]);
	assert.equal(themes.currentCatalog.themes[0]!.label, "Demo Dark");
	assert.equal(themes.currentCatalog.themes[0]!.tokenColors.length, 1);
});

test("registers extension grammars transactionally and loads resources through the API", async () => {
	const catalog: ExtensionCatalog = Object.freeze({
		generation: 1,
		extensions: [descriptor],
		diagnostics: [],
	});
	const api: IExtensionApi = {
		list: async () => catalog,
		resources: new ExtensionResourceLoaderService(async request => {
			assert.equal(request.generation, 1);
			assert.equal(request.extensionId, "ash.demo");
			assert.equal(request.path, "syntaxes/demo.tmLanguage.json");
			return new TextEncoder().encode('{"scopeName":"source.demo","patterns":[]}');
		}),
	};
	const definitions: TextMateGrammarDefinition[] = [];
	let disposed = 0;
	let batchDisposed = false;
	const textMateService = {
		grammars: {
			registerGrammars: (initial: readonly TextMateGrammarDefinition[]) => {
				definitions.splice(0, definitions.length, ...initial);
				return {
					replace: (replacement: readonly TextMateGrammarDefinition[]) => { definitions.splice(0, definitions.length, ...replacement); },
					dispose: () => { if (!batchDisposed) { batchDisposed = true; disposed += 1; definitions.splice(0); } },
					[Symbol.dispose]() { this.dispose(); },
				};
			},
			prepareGrammars: async (registration: { replace(values: readonly TextMateGrammarDefinition[]): void; }, replacement: readonly TextMateGrammarDefinition[]) => ({ commit: () => { registration.replace(replacement); return {}; } }),
			whenReady: async () => ({}),
		},
	} as unknown as ITextMateService;
	const service = new AppServerExtensionService({ api, textMateService });
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
	assert.equal(definitions.length, 1);
	assert.equal(service.debugAdapters.get("demo")?.program, "demo-adapter");
	assert.equal(service.debugAdapters.get("pure-debug")?.label, "Pure debug");
	assert.equal(DebugAdapterFactoriesRegistry.get("pure-debug"), undefined);
	assert.deepEqual(DebugAdapterFactoriesRegistry.get("demo")?.createDebugAdapter?.(), { program: "demo-adapter", arguments: ["--stdio", "", "$HOME"] });
	assert.equal(await definitions[0]!.loadGrammar(), '{"scopeName":"source.demo","patterns":[]}');
	service.dispose();
	assert.equal(DebugAdapterFactoriesRegistry.get("demo"), undefined);
	assert.equal(disposed, 1);
});

test("fails before registering when TextMate candidate preparation is unavailable", () => {
	let registrations = 0;
	const textMateService = {
		grammars: {
			registerGrammars: () => { registrations += 1; return { replace: () => { }, ...toDisposable(() => { }) }; },
			whenReady: async () => ({}),
		},
	} as unknown as ITextMateService;
	const api: IExtensionApi = { list: async () => emptyCatalog(1), resources: new ExtensionResourceLoaderService(async () => new Uint8Array()) };

	assert.throws(() => new AppServerExtensionService({ api, textMateService }), /requires a TextMate service/);
	assert.equal(registrations, 0);
});

test("disposes a TextMate service-owned grammar registration without taking duplicate ownership", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	{
		using grammars = new TextMateGrammarService();
		using service = new AppServerExtensionService({ api: { list: async () => emptyCatalog(1), resources: new ExtensionResourceLoaderService(async () => new Uint8Array()) }, textMateService: { grammars } as unknown as ITextMateService });
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
		resources: new ExtensionResourceLoaderService(async () => { reads += 1; return new TextEncoder().encode('{"colors":{},"tokenColors":[]}'); }),
	};
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });

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
		['themes/child.json', JSON.stringify({ include: './base.json', colors: { 'editor.background': '#445566' }, tokenColors: [{ scope: 'string', settings: { foreground: '#556677' } }] })],
		['themes/base.json', JSON.stringify({ colors: { 'editor.background': '#112233', 'statusBar.background': '#223344' }, tokenColors: [{ scope: 'comment', settings: { foreground: '#334455' } }] })],
	]);
	const reads: string[] = [];
	const api: IExtensionApi = {
		list: async () => ({ generation: 1, extensions: [themedDescriptor], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(async request => {
			reads.push(request.path);
			return new TextEncoder().encode(resources.get(request.path)!);
		}),
	};
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });
	await service.start();
	const theme = service.themes.currentCatalog.themes[0]!;
	assert.deepEqual(reads, ['themes/child.json', 'themes/base.json']);
	assert.deepEqual(theme.colors, { 'editor.background': '#445566', 'statusBar.background': '#223344' });
	assert.deepEqual(theme.tokenColors.map(rule => rule.scopes), [['comment'], ['string']]);
	assert.equal(theme.colors['statusBar.background'], '#223344');
});

test('loads an extension theme with a TextMate tokenColors resource', async () => {
	const themedDescriptor = descriptorWithManifest({
		name: 'demo', publisher: 'ash', version: '1.0.0',
		contributes: { themes: [{ id: 'textmate', label: 'TextMate', path: 'themes/main.json', uiTheme: 'vs-dark' }] },
	});
	const resources = new Map([
		['themes/main.json', JSON.stringify({ colors: { 'editor.background': '#112233' }, tokenColors: './syntax.tmTheme' })],
		['themes/syntax.tmTheme', '<?xml version="1.0"?><plist version="1.0"><dict><key>settings</key><array><dict><key>scope</key><string>comment</string><key>settings</key><dict><key>foreground</key><string>#123456</string></dict></dict></array></dict></plist>'],
	]);
	const api: IExtensionApi = {
		list: async () => ({ generation: 1, extensions: [themedDescriptor], diagnostics: [] }),
		resources: new ExtensionResourceLoaderService(async request => new TextEncoder().encode(resources.get(request.path)!)),
	};
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });
	await service.start();
	assert.deepEqual(service.themes.currentCatalog.themes[0]?.tokenColors.map(rule => rule.scopes), [['comment']]);
});

test("rejects a catalog whose canonical manifest digest does not match", async () => {
	const api: IExtensionApi = {
		list: async () => Object.freeze({ generation: 1, extensions: Object.freeze([Object.freeze({ ...descriptor, manifestSha256: `sha256:${"0".repeat(64)}` })]), diagnostics: Object.freeze([]) }),
		resources: new ExtensionResourceLoaderService(async () => new Uint8Array()),
	};
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });

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
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });

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
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });
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
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });
	await service.start();
	const failures: unknown[] = [];
	using listener = service.onDidFail(failure => failures.push(failure.error));
	const loading = service.reload();
	assert.equal(service.reload(), loading);
	rejectFirst(new Error('Superseded generation'));
	await assert.rejects(loading, error => error === finalFailure);
	assert.deepEqual({ requests, generation: service.currentCatalog.generation, failures }, { requests: 3, generation: 1, failures: [finalFailure] });
});

test("reloads declarations for Plugin activation and Marketplace installation changes", async () => {
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
	using service = new AppServerExtensionService({ api, eventApi, textMateService: emptyTextMateService() });
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
	listener?.({ method: 'marketplace/changed', params: { instanceId: 'manager-1', generation: 2 } });
	assert.equal((await installed.promise).generation, 3);
	listener?.({ method: 'marketplace/changed', params: { instanceId: 'manager-1', generation: 2 } });
	listener?.({ method: 'marketplace/changed', params: { instanceId: 'manager-1', generation: 1 } });
	assert.equal(generation, 3, 'replayed or older generations do not reinstall contributions');
	const restarted = deferred<WorkbenchExtensionCatalog>();
	using restartChange = service.onDidChange(next => { if (next.generation === 4) restarted.resolve(next); });
	listener?.({ method: 'marketplace/changed', params: { instanceId: 'manager-2', generation: 1 } });
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
	const service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });
	const starting = service.start();
	service.reload();
	service.dispose();

	first.resolve(emptyCatalog(1));
	await assert.doesNotReject(starting);
	assert.equal(listCalls, 1);
});

test("preserves the last active catalog when refreshed grammar materialization fails", async () => {
	const catalogs = [catalogWithGeneration(1), catalogWithGeneration(2)];
	const api: IExtensionApi = {
		list: async () => catalogs.shift()!,
		resources: new ExtensionResourceLoaderService(async request => new TextEncoder().encode(request.generation === 1 ? '{"scopeName":"source.demo","patterns":[]}' : "not a grammar")),
	};
	using grammars = new TextMateGrammarService();
	const service = new AppServerExtensionService({ api, textMateService: { grammars } as unknown as ITextMateService });
	await service.start();
	const previousCatalog = service.currentCatalog;

	await assert.rejects(service.reload());

	assert.equal(service.currentCatalog, previousCatalog);
	assert.equal(grammars.currentCatalog.grammars[0]?.scopeName, "source.demo");
	service.dispose();
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
		resources: new ExtensionResourceLoaderService(async () => new TextEncoder().encode('{"colors":{},"tokenColors":[]}')),
	};
	using languageService = new LanguageService();
	using languages = new LanguageFeaturesService();
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService(), languageService, languageConfigurationService: languages.languageConfigurationService, languageFeaturesService: languages });
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
	const textMateService = { grammars: { registerGrammars: () => ({ replace: () => { }, ...toDisposable(() => { }) }), prepareGrammars: async (registration: { replace(values: readonly TextMateGrammarDefinition[]): void; }, definitions: readonly TextMateGrammarDefinition[]) => ({ commit: () => { registration.replace(definitions); return {}; } }), whenReady: async () => ({}) } } as unknown as ITextMateService;
	const service = new AppServerExtensionService({ api, textMateService });
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
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });
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

function emptyTextMateService(): ITextMateService {
	return {
		grammars: {
			registerGrammars: () => ({ replace: () => { }, ...toDisposable(() => { }) }),
			prepareGrammars: async (registration: { replace(values: readonly TextMateGrammarDefinition[]): void; }, definitions: readonly TextMateGrammarDefinition[]) => ({ commit: () => { registration.replace(definitions); return {}; } }),
			whenReady: async () => ({}),
		},
	} as unknown as ITextMateService;
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
			semanticTokenScopes: [{ language: 'typescript', scopes: { testCustomFunction: ['entity.name.function.custom'] } }],
			icons: { 'test-extension-alias': { description: 'Extension icon', default: 'add' } },
		}
	});
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: contributed ? [manifest()] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('Unexpected resource'); }) }, textMateService: emptyTextMateService() });
	await service.start();
	for (const [type, expected] of [['hcDark', '#fedcba'], ['hcLight', '#aabbcc']]) {
		const contrast = parseUserColorTheme(JSON.stringify({ name: 'Extension contrast', type, colors: {} }));
		assert.equal(contrast.getColorCss('test.extensionAccent'), expected);
	}
	const themed = parseUserColorTheme(JSON.stringify({
		name: 'Extension mappings', colors: { 'test.extensionAccent': '#abcdef' },
		tokenColors: [{ scope: 'entity.name.function.custom', settings: { foreground: '#112233', fontStyle: 'italic' } }],
		semanticTokenColors: { function: { bold: true } },
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
	const bundle = JSON.parse(await readFile('src/ash/platform/extensions/common/generated/browser.json', 'utf8'));
	using languages = new LanguageFeaturesService();
	using languageService = new LanguageService();
	using service = new AppServerExtensionService({ api: { list: async () => bundle.catalog, resources: new ExtensionResourceLoaderService(async request => Uint8Array.from(Buffer.from(bundle.resources[request.extensionId][request.path], 'base64'))) }, textMateService: emptyTextMateService(), languageService, languageConfigurationService: languages.languageConfigurationService, languageFeaturesService: languages });
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
	using configuration = new WorkbenchConfigurationService({ initialSnapshot: { revision: 1, document: { version: 1, source } } });
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: present ? [manifest()] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('No contribution resources'); }) }, textMateService: emptyTextMateService() });
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
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: present ? [manifest()] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => { throw new Error('Matcher declarations have no resources'); }) }, textMateService: emptyTextMateService() });
	await service.start();
	using markers = new MarkerService();
	using collector = new WatchingProblemCollector(parseProblemMatchers(['$extension-service-matcher']), URI.file('/workspace'), markers, 'extension-service', () => false);
	collector.accept(new TextEncoder().encode('BUILD\napp.ts:1:2 extension issue\nREADY\n'));
	assert.equal(collector.isReady, true);
	assert.equal(markers.getAll()[0].message, 'extension issue');
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
			textMateService: emptyTextMateService(),
		});
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
	using service = new AppServerExtensionService({ api: { list: async () => ({ generation, extensions: present ? [entry] : [], diagnostics: [] }), resources: new ExtensionResourceLoaderService(async () => new TextEncoder().encode('{"scopeName":"source.demo","patterns":[]}')) }, textMateService: emptyTextMateService() });
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
