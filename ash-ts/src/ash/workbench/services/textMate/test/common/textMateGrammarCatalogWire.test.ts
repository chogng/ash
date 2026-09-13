import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "mocha";
import * as onigurumaNamespace from "vscode-oniguruma";
import { type IOnigLib } from "vscode-textmate";
import { Emitter, type Event } from "../../../../../base/common/event.js";
import { Disposable, DisposableStore, toDisposable } from "../../../../../base/common/lifecycle.js";
import { SyntaxProviderModuleHost, SyntaxProviderModuleRegistry } from "../../../../../editor/common/languages/syntax/syntaxProviderModules.js";
import { SyntaxProviderModuleWireServer } from "../../../../../editor/common/languages/syntax/syntaxProviderModuleWire.js";
import { SyntaxProviderRegistry, type SyntaxProviderRequest } from "../../../../../editor/common/languages/syntax/syntaxProviders.js";
import { SyntaxProviderWorker, SyntaxService } from "../../../../../editor/common/languages/syntax/syntaxService.js";
import { syntaxWireCodec } from "../../../../../editor/common/languages/syntax/syntaxWire.js";
import { LanguageRequestStatus } from "../../../../../editor/common/languages/languageRequestCoordinator.js";
import { LanguageWorkerWireServer, type LanguageWorkerWireClientPort } from "../../../../../editor/common/languages/languageWorkerWire.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { TextModel } from "../../../../../editor/common/model/textModel.js";
import { createTextMateSyntaxModule } from "../../common/textMateSyntaxModule.js";
import { TextMateSyntaxModuleWorkerClient } from "../../common/textMateSyntaxModuleWorkerClient.js";
import { materializeTextMateGrammarCatalog, TextMateGrammarCatalogModel, type TextMateGrammarCatalog } from "../../common/textMateGrammarCatalog.js";
import { TextMateGrammarCatalogStore } from "../../common/textMateGrammarCatalogStore.js";
import { TextMateGrammarCatalogWireClient, TextMateGrammarCatalogWireServer } from "../../common/textMateGrammarCatalogWire.js";
import { TextMateGrammarRegistry } from "../../common/textMateGrammarRegistry.js";
import { TextMateScopeThemeModel } from "../../common/textMateScopeTheme.js";
import { TextMateScopeThemeWireServer } from "../../common/textMateScopeThemeWire.js";
import { TextMateTokenizationService } from "../../common/textMateTokenizationService.js";

const onigurumaRuntime = (onigurumaNamespace as unknown as { readonly default?: typeof onigurumaNamespace }).default ?? onigurumaNamespace;
const { createOnigScanner, createOnigString, loadWASM } = onigurumaRuntime;
const onigLib = initializeOnigLib();

test("Grammar catalog model and store replace immutable revisions atomically", () => {
	using model = new TextMateGrammarCatalogModel();
	using store = new TextMateGrammarCatalogStore();
	const revisions: number[] = [];
	using listener = model.onDidChangeCatalog(catalog => revisions.push(catalog.revision));
	const first = grammarCatalog(1, "keyword.control.demo");

	model.replace(first);
	store.replace(model.currentCatalog);
	const firstSnapshot = store.currentSnapshot;

	assert.equal(Object.isFrozen(model.currentCatalog.grammars), true);
	assert.equal(firstSnapshot.getDefinitionForLanguage("demo")?.scopeName, "source.demo");
	assert.equal(store.catalogRevision, 1);
	assert.throws(() => model.replace(first), /revision must increase/);
	assert.throws(() => store.replace(first), /revision must increase/);
	assert.throws(() => model.replace({
		revision: 2,
		grammars: [
			...first.grammars,
			{ ...first.grammars[0]!, content: demoGrammar("string.quoted.demo") },
		],
	}), /Duplicate/);
	assert.equal(model.currentCatalog.revision, 1);
	assert.equal(store.currentSnapshot, firstSnapshot);

	model.replace(grammarCatalog(2, "string.quoted.demo"));
	store.replace(model.currentCatalog);
	assert.notEqual(store.currentSnapshot, firstSnapshot);
	assert.deepEqual(revisions, [1, 2]);
});

test("Grammar registry snapshots materialize transferable catalog content", async () => {
	using registry = new TextMateGrammarRegistry();
	using root = registry.register({
		scopeName: "source.demo",
		languageId: "demo",
		loadGrammar: () => demoGrammar("keyword.control.demo"),
	});
	using injection = registry.register({
		scopeName: "source.demo.todo",
		injectTo: ["source.demo"],
		loadGrammar: () => ({
			scopeName: "source.demo.todo",
			injectionSelector: "L:comment",
			patterns: [],
			repository: {
				$self: { patterns: [] },
				$base: { patterns: [] },
			},
		}),
	});

	const catalog = await materializeTextMateGrammarCatalog(registry.currentSnapshot, 3, new AbortController().signal);

	assert.equal(catalog.revision, 3);
	assert.deepEqual(catalog.grammars.map(grammar => [grammar.scopeName, grammar.languageId, grammar.injectTo]), [
		["source.demo", "demo", []],
		["source.demo.todo", undefined, ["source.demo"]],
	]);
	assert.equal(JSON.parse(catalog.grammars[1]!.content).scopeName, "source.demo.todo");
});

test("Grammar catalog wire clones catalogs and poisons stale clients", async () => {
	const [clientPort, serverPort] = createPortPair();
	using store = new TextMateGrammarCatalogStore();
	using server = new TextMateGrammarCatalogWireServer(serverPort, store);
	const invalidations: Error[] = [];
	using client = new TextMateGrammarCatalogWireClient(clientPort, error => invalidations.push(error));
	const catalog = grammarCatalog(1);

	await client.replaceCatalog(catalog);
	assert.equal(store.catalogRevision, 1);
	assert.notEqual((clientPort.sentMessages[0] as { catalog: unknown }).catalog, catalog);
	await assert.rejects(client.replaceCatalog(catalog), /revision must increase/);
	assert.equal(invalidations.length, 1);
	assert.throws(() => client.replaceCatalog(grammarCatalog(2)), /already disposed/);
});

test("Catalog-gated module Worker selects TextMate and falls back dynamically", async () => {
	using resources = new DisposableStore();
	const providers = resources.add(new SyntaxProviderRegistry());
	const modules = resources.add(new SyntaxProviderModuleRegistry());
	const grammarStore = resources.add(new TextMateGrammarCatalogStore());
	const tokenization = resources.add(new TextMateTokenizationService(grammarStore, onigLib));
	resources.add(modules.register(createTextMateSyntaxModule(tokenization)));
	resources.add(modules.register({
		id: "test.fallback",
		load: () => [{
			id: "test.fallback",
			languageIds: ["*"],
			provideTokens: (request: SyntaxProviderRequest) => ({
				tokens: [{
					range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (request.snapshot.getText().length) + 1)),
					tokenType: "fallback",
					modifiers: [],
				}],
			}),
		}],
	}));
	const host = resources.add(new SyntaxProviderModuleHost(modules, providers));
	const [clientPort, serverPort] = createPortPair();
	resources.add(new LanguageWorkerWireServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(providers)));
	resources.add(new SyntaxProviderModuleWireServer(serverPort, modules, host));
	resources.add(new TextMateGrammarCatalogWireServer(serverPort, grammarStore));
	const catalogs = resources.add(new TextMateGrammarCatalogModel(grammarCatalog(1, "keyword.control.demo")));
	const worker = resources.add(new TextMateSyntaxModuleWorkerClient(clientPort, catalogs, {
		requiredProviderModules: ["textmate.grammars", "test.fallback"],
	}));
	const localProviders = resources.add(new SyntaxProviderRegistry());
	const model = resources.add(new TextModel("if"));
	const syntax = resources.add(new SyntaxService(model, localProviders, { workerFactory: () => worker }));

	assert.equal((await syntax.requestTokens("demo")).status, LanguageRequestStatus.Applied);
	assert.equal(syntax.tokens.result!.value.tokens[0]!.tokenType, "keyword");
	assert.equal((await syntax.requestTokens("plain")).status, LanguageRequestStatus.Applied);
	assert.equal(syntax.tokens.result!.value.tokens[0]!.tokenType, "fallback");

	catalogs.replace(grammarCatalog(2, "string.quoted.demo"));
	assert.equal((await syntax.requestTokens("demo")).status, LanguageRequestStatus.Applied);
	assert.equal(syntax.tokens.result!.value.tokens[0]!.tokenType, "string");
	const catalogRequests = clientPort.sentMessages.filter(message => (message as { protocol?: string }).protocol === "ash.textmate.grammar-catalog");
	assert.equal(catalogRequests.length, 2);
});

test("Scope themes cross the Syntax Worker boundary and invalidate cached token styles", async () => {
	using resources = new DisposableStore();
	const providers = resources.add(new SyntaxProviderRegistry());
	const modules = resources.add(new SyntaxProviderModuleRegistry());
	const grammarStore = resources.add(new TextMateGrammarCatalogStore());
	const workerThemes = resources.add(new TextMateScopeThemeModel());
	const tokenization = resources.add(new TextMateTokenizationService(grammarStore, onigLib, {
		scopeResolver: scopes => workerThemes.resolve(scopes),
	}));
	resources.add(modules.register(createTextMateSyntaxModule(tokenization)));
	const host = resources.add(new SyntaxProviderModuleHost(modules, providers));
	const [clientPort, serverPort] = createPortPair();
	resources.add(new LanguageWorkerWireServer(serverPort, syntaxWireCodec, new SyntaxProviderWorker(providers)));
	resources.add(new SyntaxProviderModuleWireServer(serverPort, modules, host));
	resources.add(new TextMateGrammarCatalogWireServer(serverPort, grammarStore));
	resources.add(new TextMateScopeThemeWireServer(serverPort, workerThemes, () => tokenization.invalidateTokenCaches()));
	const catalogs = resources.add(new TextMateGrammarCatalogModel(grammarCatalog(1)));
	const themes = resources.add(new TextMateScopeThemeModel());
	const worker = resources.add(new TextMateSyntaxModuleWorkerClient(clientPort, catalogs, {
		requiredProviderModules: ["textmate.grammars"],
		scopeTheme: themes,
	}));
	const localProviders = resources.add(new SyntaxProviderRegistry());
	const model = resources.add(new TextModel("if"));
	const syntax = resources.add(new SyntaxService(model, localProviders, { workerFactory: () => worker }));

	assert.equal((await syntax.requestTokens("demo")).status, LanguageRequestStatus.Applied);
	assert.equal(syntax.tokens.result!.value.tokens[0]!.tokenType, "keyword");

	themes.replace({ revision: 1, rules: [{ selector: "keyword.control.demo", tokenType: "keyword", modifiers: ["declaration"] }] });
	assert.equal((await syntax.requestTokens("demo")).status, LanguageRequestStatus.Applied);
	assert.deepEqual(syntax.tokens.result!.value.tokens[0], {
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (2) + 1)),
		tokenType: "keyword",
		modifiers: ["declaration"],
	});
	assert.equal(clientPort.sentMessages.filter(message => (message as { protocol?: string }).protocol === "ash.textmate.scope-theme").length, 1);
});

interface MemoryWirePort extends LanguageWorkerWireClientPort {
	readonly sentMessages: unknown[];
	connect(peer: MemoryWirePort): void;
}

function createPortPair(): readonly [MemoryWirePort, MemoryWirePort] {
	const first = new TestWirePort();
	const second = new TestWirePort();
	first.connect(second);
	second.connect(first);
	return [first, second];
}

class TestWirePort extends Disposable implements MemoryWirePort {
	private readonly messageEmitter = this._register(new Emitter<unknown>());
	private readonly failureEmitter = this._register(new Emitter<unknown>());
	private peer: TestWirePort | undefined;

	readonly sentMessages: unknown[] = [];
	readonly onMessage: Event<unknown> = this.messageEmitter.event;
	readonly onFailure: Event<unknown> = this.failureEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.peer = undefined;
		}));
	}

	connect(peer: TestWirePort): void {
		this.peer = peer;
	}

	send(message: unknown): void {
		if (this.isDisposed || !this.peer) throw new ReferenceError("Test wire port is unavailable");
		const cloned = structuredClone(message);
		const peer = this.peer;
		this.sentMessages.push(cloned);
		queueMicrotask(() => {
			if (!peer.isDisposed) peer.messageEmitter.fire(cloned);
		});
	}
}

function grammarCatalog(revision: number, keywordScope = "keyword.control.demo"): TextMateGrammarCatalog {
	return {
		revision,
		grammars: [{
			scopeName: "source.demo",
			languageId: "demo",
			injectTo: [],
			content: demoGrammar(keywordScope),
		}],
	};
}

function demoGrammar(keywordScope: string): string {
	return JSON.stringify({
		scopeName: "source.demo",
		patterns: [{ match: "\\bif\\b", name: keywordScope }],
		repository: {},
	});
}

async function initializeOnigLib(): Promise<IOnigLib> {
	const mainUrl = import.meta.resolve("vscode-oniguruma");
	const bytes = await readFile(new URL("onig.wasm", mainUrl));
	const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	await loadWASM(data);
	return Object.freeze({ createOnigScanner, createOnigString });
}
