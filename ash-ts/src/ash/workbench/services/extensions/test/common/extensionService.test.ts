import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "mocha";
import { readFile } from 'node:fs/promises';
import { WorkbenchFileIconThemesRegistry } from '../../../themes/common/themeExtensionPoints.js';
import { DisposableTracker, installDisposableTracker, toDisposable } from "../../../../../base/common/lifecycle.js";
import type { ExtensionCatalog, ExtensionDescriptor, IExtensionApi } from "../../../../../platform/extensions/common/extensionApi.js";
import type { IServerEventApi } from "../../../../../platform/app-server/common/appServerApi.js";
import type { ServerNotification } from "../../../../../platform/app-server/common/generated/index.js";
import { AppServerExtensionService } from "../../browser/appServerExtensionService.js";
import { parseExtensionManifest, type ExtensionCatalog as WorkbenchExtensionCatalog } from "../../common/extensionService.js";
import { parseJsonc } from "../../common/jsonc.js";
import { createExtensionSnippetProvider, parseExtensionSnippetFile } from "../../common/extensionSnippetProvider.js";
import { ExtensionThemeRegistry, parseExtensionTheme } from "../../common/extensionTheme.js";
import { ExtensionDebugAdapterRegistry } from "../../common/extensionDebugAdapter.js";
import { DebugAdapterFactoriesRegistry } from "../../../debug/common/debugAdapterFactory.js";
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
		debuggers: [{ type: "demo", label: "Demo Debug", debugAdapter: { program: "demo-adapter", args: ["--stdio"] } }],
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
		readResource: async request => {
			assert.equal(request.generation, 1);
			assert.equal(request.extensionId, "ash.demo");
			assert.equal(request.path, "syntaxes/demo.tmLanguage.json");
			return new TextEncoder().encode('{"scopeName":"source.demo","patterns":[]}');
		},
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
			prepareGrammars: async (registration: { replace(values: readonly TextMateGrammarDefinition[]): void }, replacement: readonly TextMateGrammarDefinition[]) => ({ commit: () => { registration.replace(replacement); return {}; } }),
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
	await service.reload();

	assert.equal(service.currentCatalog.generation, catalog.generation);
	assert.equal(service.currentCatalog.extensions[0]?.id, descriptor.id);
	assert.equal(service.currentCatalog.extensions[0]?.packageSha256, descriptor.packageSha256);
	assert.equal("manifestJson" in service.currentCatalog.extensions[0]!, false);
	assert.equal(definitions.length, 1);
	assert.equal(service.debugAdapters.get("demo")?.program, "demo-adapter");
	assert.deepEqual(DebugAdapterFactoriesRegistry.get("demo")?.createDebugAdapter(), { program: "demo-adapter", arguments: ["--stdio"] });
	assert.equal(await definitions[0]!.loadGrammar(), '{"scopeName":"source.demo","patterns":[]}');
	service.dispose();
	assert.equal(DebugAdapterFactoriesRegistry.get("demo"), undefined);
	assert.equal(disposed, 1);
});

test("fails before registering when TextMate candidate preparation is unavailable", () => {
	let registrations = 0;
	const textMateService = {
		grammars: {
			registerGrammars: () => { registrations += 1; return { replace: () => {}, ...toDisposable(() => {}) }; },
			whenReady: async () => ({}),
		},
	} as unknown as ITextMateService;
	const api: IExtensionApi = { list: async () => emptyCatalog(1), readResource: async () => new Uint8Array() };

	assert.throws(() => new AppServerExtensionService({ api, textMateService }), /requires a TextMate service/);
	assert.equal(registrations, 0);
});

test("disposes a TextMate service-owned grammar registration without taking duplicate ownership", () => {
	const tracker = new DisposableTracker();
	using installation = installDisposableTracker(tracker);
	{
		using grammars = new TextMateGrammarService();
		using service = new AppServerExtensionService({ api: { list: async () => emptyCatalog(1), readResource: async () => new Uint8Array() }, textMateService: { grammars } as unknown as ITextMateService });
	}
	tracker.assertNoLeaks();
});

test("reads each generation-scoped resource once while preparing one catalog", async () => {
	const themedDescriptor = descriptorWithManifest({
			name: "demo",
			publisher: "ash",
			version: "1.0.0",
			contributes: { themes: [
				{ id: "first", label: "First", path: "themes/shared.json", uiTheme: "vs-dark" },
				{ id: "second", label: "Second", path: "themes/shared.json", uiTheme: "vs" },
			] },
	});
	let reads = 0;
	const api: IExtensionApi = {
		list: async () => Object.freeze({ generation: 7, extensions: Object.freeze([themedDescriptor]), diagnostics: Object.freeze([]) }),
		readResource: async () => { reads += 1; return new TextEncoder().encode('{"colors":{},"tokenColors":[]}'); },
	};
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });

	await service.start();

	assert.equal(reads, 1);
	assert.equal(service.themes.currentCatalog.themes.length, 2);
});

test("rejects a catalog whose canonical manifest digest does not match", async () => {
	const api: IExtensionApi = {
		list: async () => Object.freeze({ generation: 1, extensions: Object.freeze([Object.freeze({ ...descriptor, manifestSha256: `sha256:${"0".repeat(64)}` })]), diagnostics: Object.freeze([]) }),
		readResource: async () => new Uint8Array(),
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
		readResource: async () => new Uint8Array(),
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

test("reloads declarative extensions when the Plugin activation generation changes", async () => {
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
		readResource: async () => new Uint8Array(),
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
});

test("dispose suppresses a queued reload and ignores the in-flight result", async () => {
	const first = deferred<ExtensionCatalog>();
	let listCalls = 0;
	const api: IExtensionApi = {
		list: () => {
			listCalls += 1;
			return first.promise;
		},
		readResource: async () => new Uint8Array(),
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
		readResource: async request => new TextEncoder().encode(request.generation === 1 ? '{"scopeName":"source.demo","patterns":[]}' : "not a grammar"),
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
		readResource: async () => new TextEncoder().encode('{"colors":{},"tokenColors":[]}'),
	};
	using languageService = new LanguageService();
	using languages = new LanguageFeaturesService();
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService(), languageService, languageConfigurationService: languages.languageConfigurationService, languageFeaturesService: languages });
	const observations: Array<{ readonly themeCount: number; readonly adapterCount: number; readonly generation: number }> = [];
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
		readResource: async () => new Uint8Array(),
	};
	const textMateService = { grammars: { registerGrammars: () => ({ replace: () => {}, ...toDisposable(() => {}) }), prepareGrammars: async (registration: { replace(values: readonly TextMateGrammarDefinition[]): void }, definitions: readonly TextMateGrammarDefinition[]) => ({ commit: () => { registration.replace(definitions); return {}; } }), whenReady: async () => ({}) } } as unknown as ITextMateService;
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
	const manifest = JSON.parse(await readFile('../extensions/theme-seti/package.json', 'utf8'));
	const entry = descriptorWithManifest({ ...manifest, name: 'demo' });
	let generation = 1;
	let fail = false;
	const requests: string[] = [];
	const api: IExtensionApi = {
		list: async () => ({ generation, extensions: [entry], diagnostics: [] }),
		readResource: async request => {
			assert.equal(request.generation, generation);
			requests.push(request.path);
			if (fail && request.path.endsWith('.woff')) { throw new Error('Font unavailable'); }
			return readFile('../extensions/theme-seti/' + request.path);
		},
	};
	using service = new AppServerExtensionService({ api, textMateService: emptyTextMateService() });
	await service.start();
	const theme = WorkbenchFileIconThemesRegistry.getThemes().find(theme => theme.id === 'vs-seti');
	assert.ok(theme?.resolveFileIcon('main.ts', true)?.character);
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
			registerGrammars: () => ({ replace: () => {}, ...toDisposable(() => {}) }),
			prepareGrammars: async (registration: { replace(values: readonly TextMateGrammarDefinition[]): void }, definitions: readonly TextMateGrammarDefinition[]) => ({ commit: () => { registration.replace(definitions); return {}; } }),
			whenReady: async () => ({}),
		},
	} as unknown as ITextMateService;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}
