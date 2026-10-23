import { expect, type Page } from '@playwright/test';
import { Editor } from '../../../../../test/automation/editor.js';
import { ShowLightbulbIconMode } from '../../common/config/editorOptions.js';
import { useBrowserTests } from '../../../../../test/unit/browser/context.js';
import { createLanguageFeatureRequest, TokenizationRegistry } from '../../common/languages.js';
import { Emitter } from '../../../base/common/event.js';
import { editorWorkerWireCodec, EditorWorker } from '../../common/services/editorWebWorker.js';
import { FormattingConflicts, FormattingKind, FormattingMode } from '../../contrib/format/browser/format.js';
import { type DocumentFormattingEditProvider, type OnTypeFormattingEditProvider } from '../../common/languages.js';
import { TextModel } from '../../common/model/textModel.js';
import assert from "node:assert/strict";
import { test, suiteTeardown, suite, teardown } from 'mocha';
import { JSDOM } from "jsdom";
import { URI } from "../../../base/common/uri.js";
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { AbstractDisposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { lightColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { LanguageFeaturesService } from "../../common/services/languageFeaturesService.js";
import { ILanguageFeaturesService } from '../../common/services/languageFeatures.js';
import { IInstantiationService } from '../../../platform/instantiation/common/instantiation.js';
import { IMarkdownRendererService } from '../../../platform/markdown/browser/markdownRenderer.js';
import { ILayoutService } from '../../../platform/layout/browser/layoutService.js';
import { ILanguageService } from '../../common/languages/language.js';
import { EditorContributionInstantiation } from '../../browser/editorExtensions.js';
import { TestLanguageConfigurationService } from '../common/modes/testLanguageConfigurationService.js';
import { StandaloneServiceCollection, StandaloneServices } from "../../standalone/browser/standaloneServices.js";
import { WorkerTextModelSyncServer } from '../../common/services/textModelSync/textModelSync.impl.js';
import type { IMonarchLanguage } from '../../editor.api.js';
import { installEditorTestDom } from './editorTestGlobals.js';
import { setIconResolver } from '../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../platform/theme/common/iconRegistry.js';

function createTestDom(markup: string): JSDOM {
	const dom = new JSDOM(markup);
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
	return dom;
}

const browserEnvironment = createTestDom("<!doctype html><body></body>");
const forcedColors = new browserEnvironment.window.EventTarget();
Object.defineProperties(forcedColors, {
	matches: { configurable: true, value: false, writable: true },
	media: { configurable: true, value: "(forced-colors: active)" },
});
Object.defineProperty(browserEnvironment.window, "matchMedia", {
	configurable: true,
	value: (query: string) => {
		if (query === "(forced-colors: active)") return forcedColors;
		assert.ok(["(prefers-reduced-motion: reduce)", "(prefers-reduced-transparency: reduce)"].includes(query) || /^\(resolution: [\d.]+dppx\)$/u.test(query));
		return Object.assign(new browserEnvironment.window.EventTarget(), { matches: false, media: query });
	},
});
let createdWorkerCount = 0;
let terminatedWorkerCount = 0;
class TestWorker extends browserEnvironment.window.EventTarget {
	private readonly incoming = new Emitter<unknown>();
	private readonly server = new WorkerTextModelSyncServer({
		onMessage: this.incoming.event,
		send: message => {
			const data = structuredClone(message);
			queueMicrotask(() => this.dispatchEvent(new browserEnvironment.window.MessageEvent('message', { data })));
		},
		dispose() { },
		[Symbol.dispose]() { },
	}, editorWorkerWireCodec, new EditorWorker());
	constructor() {
		super();
		createdWorkerCount += 1;
	}
	postMessage(message: unknown): void {
		const data = structuredClone(message);
		queueMicrotask(() => this.incoming.fire(data));
	}
	terminate(): void {
		this.server.dispose();
		this.incoming.dispose();
		terminatedWorkerCount += 1;
	}
}
class TestResizeObserver {
	observe(): void { }
	unobserve(): void { }
	disconnect(): void { }
}
const installedGlobals = installEditorTestDom(browserEnvironment, [
	'Node', 'Element', 'HTMLElement', 'Event', 'InputEvent',
], { ResizeObserver: TestResizeObserver, Worker: TestWorker });

const stanza = await import("../../editor.main.js");

suiteTeardown(() => {
	installedGlobals.dispose();
	browserEnvironment.window.close();
});

test("standalone service collection honors explicit first-scope overrides", () => {
	const languageConfigurations = new TestLanguageConfigurationService();
	const languages = new LanguageFeaturesService();
	const services = new StandaloneServiceCollection({ languageConfigurationService: languageConfigurations, languageFeaturesService: languages });
	assert.equal(services.languageFeaturesService, languages);
	assert.equal(services.themeService.getColorTheme().id, lightColorTheme.id);
	assert.ok(services.get(ILogService) instanceof NullLoggerService);
	services.dispose();
	assert.equal(languages.isDisposed, false);
	languages.dispose();
	languageConfigurations.dispose();
});

test('standalone language identity and editing rules require host registration', () => {
	using services = new StandaloneServiceCollection({});
	const resource = URI.file('/project/main.ts');
	using model = services.modelService.createModel('const value = 1;', services.languageService.createByFilepathOrFirstLine(resource), resource);
	assert.deepEqual(services.languageService.getRegisteredLanguageIds(), ['plaintext']);
	assert.equal(model.getLanguageId(), 'plaintext');
	assert.equal(services.languageConfigurationService.getLanguageConfiguration('typescript').comments, null);

	using language = services.languageService.registerLanguage({ id: 'typescript', extensions: ['.ts'] });
	using configuration = services.languageConfigurationService.register('typescript', { comments: { lineComment: '//' } });
	assert.equal(model.getLanguageId(), 'typescript');
	assert.equal(services.languageConfigurationService.getLanguageConfiguration('typescript').comments?.lineCommentToken, '//');

	configuration.dispose();
	language.dispose();
	assert.equal(model.getLanguageId(), 'plaintext');
	assert.equal(services.languageConfigurationService.getLanguageConfiguration('typescript').comments, null);
});

test('standalone services leave formatter policy with the active Code owner', async () => {
	using model = new TextModel('alpha');
	const first: DocumentFormattingEditProvider = { provideDocumentFormattingEdits: () => [] };
	const second: DocumentFormattingEditProvider = { provideDocumentFormattingEdits: () => [] };
	const providers = [first, second];
	using host = FormattingConflicts.setFormatterSelector(async choices => choices[1]);
	assert.strictEqual(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File), second);
	using services = new StandaloneServiceCollection({});
	assert.strictEqual(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File), second);
	services.dispose();
	assert.strictEqual(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File), second);
});

test('standalone initialization defers callbacks and releases registrations across initialization', () => {
	const calls: string[] = [];
	const removed = StandaloneServices.withServices(() => {
		calls.push('removed');
		return toDisposable(() => calls.push('dispose-removed'));
	});
	removed.dispose();
	using pending = StandaloneServices.withServices(() => {
		calls.push('initialized');
		assert.ok(StandaloneServices.get(ILanguageService));
		return toDisposable(() => calls.push('dispose-initialized'));
	});
	assert.deepEqual([...calls], []);
	const services = StandaloneServices.initialize();
	assert.equal(services.get(IInstantiationService), services);
	assert.equal(StandaloneServices.get(IInstantiationService), services);
	assert.equal(StandaloneServices.get(ILanguageService), services.languageService);
	assert.equal(StandaloneServices.get(ILanguageFeaturesService), services.languageFeaturesService);
	assert.deepEqual([...calls], ['initialized']);
	using immediate = StandaloneServices.withServices(() => {
		calls.push('immediate');
		return toDisposable(() => calls.push('dispose-immediate'));
	});
	pending.dispose();
	immediate.dispose();
	assert.deepEqual(calls, ['initialized', 'immediate', 'dispose-initialized', 'dispose-immediate']);
});

test('standalone language activation is once per language and exposes independent descriptions', () => {
	const calls: string[] = [];
	using resources = new DisposableStore();
	resources.add(stanza.languages.registerLanguages([
		{ description: { id: 'activate-first', extensions: ['.first'] } },
		{ description: { id: 'activate-second' } },
	]));
	resources.add(stanza.languages.onLanguageEncountered('activate-first', () => calls.push('basic')));
	resources.add(stanza.languages.onLanguage('activate-first', () => calls.push('rich')));
	resources.add(stanza.languages.onLanguage('activate-second', () => calls.push('changed')));
	const removed = stanza.languages.onLanguage('activate-first', () => calls.push('removed'));
	removed.dispose();
	const descriptions = stanza.languages.getLanguages();
	descriptions.find(language => language.id === 'activate-first')!.extensions!.push('.mutated');
	assert.deepEqual(stanza.languages.getLanguages().find(language => language.id === 'activate-first')!.extensions, ['.first']);
	const model = resources.add(stanza.editor.createModel('alpha', 'activate-first'));
	resources.add(stanza.editor.createModel('beta', 'activate-first'));
	stanza.editor.setModelLanguage(model, 'activate-second');
	stanza.editor.setModelLanguage(model, 'activate-first');
	assert.deepEqual(calls, ['basic', 'rich', 'changed']);
});

test('standalone token providers normalize offsets without modifying provider tokens', () => {
	const input = [
		{ startIndex: 7, scopes: 'keyword' },
		{ startIndex: 5, scopes: 'entity' },
		{ startIndex: 3, scopes: 'string' },
	];
	const state = { clone() { return this; }, equals(other: unknown) { return other === this; } };
	using registration = stanza.languages.setTokensProvider('plaintext', {
		getInitialState: () => state,
		tokenize: () => ({ tokens: input, endState: state }),
	});
	const support = TokenizationRegistry.get('plaintext')!;
	const tokens = support.tokenize('alpha beta', false, state).tokens;
	assert.deepEqual(tokens.map(token => [token.offset, token.type, token.language]), [
		[0, 'keyword', 'plaintext'], [5, 'entity', 'plaintext'], [5, 'string', 'plaintext'],
	]);
	const encoded = support.tokenizeEncoded!('alpha beta', false, state).tokens;
	assert.deepEqual([encoded[0], encoded[2], encoded[4]], [0, 5, 5]);
	assert.deepEqual(input.map(token => token.startIndex), [7, 5, 3]);
});

test('standalone Monarch registrations own lazy tokenizer creation, replacement and disposal', async () => {
	using language = stanza.languages.registerLanguages([{ description: { id: 'monarch-registration' } }]);
	const definition: IMonarchLanguage = { tokenizer: { root: [[/\w+/, 'identifier']] } };
	let resolve!: (value: IMonarchLanguage) => void;
	const removed = stanza.languages.setMonarchTokensProvider('monarch-registration', new Promise(done => { resolve = done; }));
	const pending = TokenizationRegistry.getOrCreate('monarch-registration');
	removed.dispose();
	resolve(definition);
	assert.equal(await pending, null);
	let calls = 0;
	using lazy = stanza.languages.registerTokensProviderFactory('monarch-registration', {
		create: async () => { calls++; return definition; },
	});
	const tokenizer = (await TokenizationRegistry.getOrCreate('monarch-registration'))!;
	assert.equal(await TokenizationRegistry.getOrCreate('monarch-registration'), tokenizer);
	assert.equal(calls, 1);
	assert.equal(tokenizer.tokenize('word', false, tokenizer.getInitialState()).tokens[0]!.type, 'identifier.monarch-registration');
	assert.throws(() => stanza.languages.setMonarchTokensProvider('monarch-registration', { tokenizer: { root: [{ include: '@missing' }] } }), /Unknown tokenizer state/);
	assert.equal(TokenizationRegistry.get('monarch-registration'), tokenizer);
	using replacement = stanza.languages.setMonarchTokensProvider('monarch-registration', { tokenizer: { root: [[/\w+/, 'string']] } });
	lazy.dispose();
	assert.throws(() => tokenizer.tokenize('word', false, tokenizer.getInitialState()), /disposed/i);
	const current = TokenizationRegistry.get('monarch-registration')!;
	assert.equal(current.tokenize('word', false, current.getInitialState()).tokens[0]!.type, 'string.monarch-registration');
	replacement.dispose();
	assert.equal(TokenizationRegistry.get('monarch-registration'), null);
});

test('standalone colorization escapes markup, expands tabs and creates no model or worker', async () => {
	using resources = new DisposableStore();
	resources.add(stanza.languages.registerLanguages([{ description: { id: 'colorize-test', mimetypes: ['text/colorize-test'] } }]));
	resources.add(stanza.languages.setMonarchTokensProvider('colorize-test', { tokenizer: { root: [[/word/, 'keyword'], [/./, '']] } }));
	stanza.editor.defineTheme('colorize-theme', { base: 'vs', inherit: true, rules: [{ token: 'keyword', foreground: '123456', fontStyle: 'bold' }], colors: {} });
	stanza.editor.setTheme('colorize-theme');
	const models = stanza.editor.getModels().length;
	const workers = createdWorkerCount;
	const html = await stanza.editor.colorize('\uFEFFword\t<img>\r\n&', 'colorize-test', { tabSize: 3 });
	const element = document.createElement('pre');
	element.innerHTML = html;
	assert.equal(element.textContent, 'word\u00a0\u00a0<img>&');
	assert.equal(element.querySelectorAll('br').length, 1);
	assert.equal(element.querySelectorAll('img').length, 0);
	assert.equal(element.firstElementChild?.getAttribute('style'), 'color: #123456;font-weight: bold;');
	element.setAttribute('data-lang', 'text/colorize-test');
	element.textContent = 'word';
	await stanza.editor.colorizeElement(element, { theme: 'colorize-theme' });
	assert.equal(element.firstElementChild?.textContent, 'word');
	assert.equal(element.firstElementChild?.getAttribute('style'), 'color: #123456;font-weight: bold;');
	assert.equal(stanza.editor.getModels().length, models);
	assert.equal(createdWorkerCount, workers);
	await assert.rejects(stanza.editor.colorize('word', 'colorize-test', { tabSize: 0 }), /positive integer/);
	stanza.editor.setTheme('ash-light');
});

test('standalone Markdown service highlights an alias in the output document without creating models or workers', async () => {
	using resources = new DisposableStore();
	resources.add(StandaloneServices.get(ILanguageService).registerLanguage({ id: 'markdown-highlight', aliases: ['MarkdownTest'] }));
	resources.add(stanza.languages.setMonarchTokensProvider('markdown-highlight', { tokenizer: { root: [[/word/, 'keyword'], [/./, '']] } }));
	stanza.editor.defineTheme('markdown-highlight-theme', { base: 'vs', inherit: true, rules: [{ token: 'keyword', foreground: '123456' }], colors: {} });
	stanza.editor.setTheme('markdown-highlight-theme');
	const models = stanza.editor.getModels().length;
	const workers = createdWorkerCount;
	const dom = createTestDom('<!doctype html><body></body>');
	try {
		let resolveCompleted!: () => void;
		const completed = new Promise<void>(resolve => { resolveCompleted = resolve; });
		using result = StandaloneServices.get(IMarkdownRendererService).render({ value: '```MarkdownTest\nword <img>\n```' }, {
			ownerDocument: dom.window.document,
			asyncRenderCallback: resolveCompleted,
		});
		await completed;
		const code = result.element.querySelector('pre > code')!;
		assert.equal(code.ownerDocument, dom.window.document);
		assert.equal(code.textContent?.replaceAll('\u00a0', ' '), 'word <img>');
		assert.equal(code.querySelector('img'), null);
		assert.equal(code.firstElementChild?.getAttribute('style'), 'color: #123456;');
		assert.deepEqual({ models: stanza.editor.getModels().length, workers: createdWorkerCount }, { models, workers });
	} finally {
		dom.window.close();
		stanza.editor.setTheme('ash-light');
	}
});

test("standalone theme APIs register, select, and project a named theme", () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	stanza.editor.defineNamedTheme("standalone-test", {
		label: "Standalone Test",
		colorScheme: stanza.ColorScheme.Dark,
		colors: { "editor.background": "#101010" },
	});
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	const editor = stanza.editor.create(container, { value: "theme", theme: "standalone-test" });
	assert.equal(container.getAttribute("data-color-theme"), "standalone-test");
	assert.equal(dom.window.getComputedStyle(dom.window.document.documentElement).getPropertyValue("--ash-editor-background"), "#101010");

	stanza.editor.setTheme("ash-light");
	assert.equal(container.getAttribute("data-color-theme"), "ash-light");
	editor.dispose();
	dom.window.close();
});

test("standalone public API keeps compiled theme snapshots internal", () => {
	for (const exportName of ["lightColorTheme", "darkColorTheme", "highContrastLightColorTheme", "highContrastDarkColorTheme"]) {
		assert.equal(exportName in stanza, false);
	}
	assert.equal(stanza.editor.ContentWidgetPositionPreference.EXACT, stanza.ContentWidgetPositionPreference.EXACT);
	assert.equal(stanza.editor.OverlayWidgetPositionPreference.TOP_CENTER, stanza.OverlayWidgetPositionPreference.TOP_CENTER);
	assert.equal(stanza.editor.PositionAffinity.LeftOfInjectedText, stanza.PositionAffinity.LeftOfInjectedText);
});

test('standalone editors can start without allocating a model or worker and attach a shared model later', () => {
	const container = browserEnvironment.window.document.createElement('div');
	browserEnvironment.window.document.body.append(container);
	const models = stanza.editor.getModels();
	const workers = createdWorkerCount;
	const createdModels: string[] = [];
	using listener = stanza.editor.onDidCreateModel(model => createdModels.push(model.uri.toString()));
	using editor = stanza.editor.create(container, { model: null, value: 'ignored', language: 'typescript' });
	const id = editor.getId();
	assert.equal(typeof id, 'string');
	assert.deepEqual({ model: editor.getModel(), value: editor.getValue(), state: editor.saveViewState(), createdModels, workers: createdWorkerCount - workers }, {
		model: null, value: '', state: null, createdModels: [], workers: 0,
	});
	assert.deepEqual(stanza.editor.getModels(), models);
	assert.ok(stanza.editor.getEditors().includes(editor));
	editor.layout({ width: 500, height: 200 });
	using model = stanza.editor.createModel('attached');
	editor.setModel(model);
	assert.equal(editor.getValue(), 'attached');
	assert.equal(editor.getId(), id);
	editor.setModel(null);
	assert.equal(editor.getModel(), null);
	assert.equal(model.isDisposed(), false);
	editor.dispose();
	assert.equal(model.isDisposed(), false);
	assert.ok(!stanza.editor.getEditors().includes(editor));
	container.remove();
});

test('standalone updateOptions changes the window theme and forced-color preference', () => {
	const container = browserEnvironment.window.document.createElement('div');
	browserEnvironment.window.document.body.append(container);
	using editor = stanza.editor.create(container, { value: 'theme' });
	try {
		editor.updateOptions({ theme: 'ash-dark' });
		assert.equal(container.getAttribute('data-color-theme'), 'ash-dark');
		Object.assign(forcedColors, { matches: true });
		forcedColors.dispatchEvent(new browserEnvironment.window.Event('change'));
		assert.equal(container.getAttribute('data-color-theme'), 'ash-high-contrast-dark');
		editor.updateOptions({ autoDetectHighContrast: false });
		assert.equal(container.getAttribute('data-color-theme'), 'ash-dark');
		editor.updateOptions({ autoDetectHighContrast: true });
		assert.equal(container.getAttribute('data-color-theme'), 'ash-high-contrast-dark');
	} finally {
		Object.assign(forcedColors, { matches: false });
		forcedColors.dispatchEvent(new browserEnvironment.window.Event('change'));
		editor.updateOptions({ theme: 'ash-light' });
		container.remove();
	}
});

test("standalone languages API exposes provider value types", () => {
	assert.equal(stanza.languages.LanguageCompletionItemKind, stanza.LanguageCompletionItemKind);
	assert.equal(stanza.languages.LanguageCompletionInsertTextFormat, stanza.LanguageCompletionInsertTextFormat);
	assert.equal(stanza.languages.LanguageCompletionTriggerKind, stanza.LanguageCompletionTriggerKind);
	assert.equal(stanza.languages.LanguageDiagnosticSeverity, stanza.LanguageDiagnosticSeverity);
	assert.equal(stanza.languages.DocumentHighlightKind, stanza.DocumentHighlightKind);
	assert.equal(stanza.languages.RGBA8, stanza.RGBA8);
	assert.deepEqual(new stanza.languages.RGBA8(300, -1, 64, 255), new stanza.RGBA8(255, 0, 64, 255));
});

test('standalone on-type providers retain triggers, model arguments, and registration lifetime', async () => {
	using model = stanza.editor.createModel('alpha;', 'plaintext', URI.parse('inmemory://on-type/model'));
	using source = new CancellationTokenSource();
	const position = new stanza.Position(1, 7);
	const options = { tabSize: 2, insertSpaces: true };
	const provider: OnTypeFormattingEditProvider = {
		autoFormatTriggerCharacters: [';', '}'],
		provideOnTypeFormattingEdits(receivedModel, receivedPosition, ch, receivedOptions, token) {
			assert.equal(receivedModel, model);
			assert.equal(receivedPosition, position);
			assert.equal(ch, ';');
			assert.deepEqual(receivedOptions, options);
			assert.equal(token, source.token);
			return [{ range: new stanza.Range(1, 1, 1, 7), text: 'ALPHA;' }];
		},
	};
	using registration = stanza.languages.registerOnTypeFormattingEditProvider('plaintext', provider);
	const registry = StandaloneServices.get(ILanguageFeaturesService).onTypeFormattingEditProvider;
	assert.deepEqual(registry.ordered(model), [provider]);
	assert.deepEqual(provider.autoFormatTriggerCharacters, [';', '}']);
	assert.deepEqual(await registry.ordered(model)[0]!.provideOnTypeFormattingEdits(model, position, ';', options, source.token), [{ range: new stanza.Range(1, 1, 1, 7), text: 'ALPHA;' }]);
	registration.dispose();
	assert.deepEqual(registry.ordered(model), []);
});

test('standalone languages API replaces one language generation without stale registrations', () => {
	const changes: string[] = [];
	using listener = stanza.languages.onDidChangeLanguages(event => changes.push(event.languageId));
	using descriptions = stanza.languages.registerLanguages([{
		description: { id: 'stanza-generation-a', extensions: ['.generation-a'] },
	}]);

	assert.equal(stanza.languages.resolveLanguageId({ resource: URI.parse('file:///sample.generation-a') }), 'stanza-generation-a');
	descriptions.replace([{
		description: { id: 'stanza-generation-b', extensions: ['.generation-b'] },
	}]);
	assert.equal(stanza.languages.resolveLanguageId({ resource: URI.parse('file:///sample.generation-a') }), undefined);
	assert.equal(stanza.languages.resolveLanguageId({ resource: URI.parse('file:///sample.generation-b') }), 'stanza-generation-b');
	assert.deepEqual(changes, ['stanza-generation-a', 'stanza-generation-a', 'stanza-generation-b']);
});

test('standalone language events preserve listener context and dispose with the supplied store', () => {
	using listeners = new DisposableStore();
	const context = { calls: 0 };
	stanza.languages.onDidChangeLanguages(function (this: typeof context) {
		this.calls += 1;
	}, context, listeners);
	using registration = stanza.languages.registerLanguages([{ description: { id: 'listener-context' } }]);
	assert.equal(context.calls, 1);
	listeners.dispose();
	registration.dispose();
	assert.equal(context.calls, 1);
});

test('standalone languages API replaces provider batches atomically', () => {
	const first = {
		provideHover: () => ({ contents: ['first'] }),
	};
	const second = {
		provideHover: () => ({ contents: ['second'] }),
	};
	using model = new stanza.TextModel('', { languageId: 'stanza-batch' });
	using batch = stanza.languages.registerProviderBatch({ hovers: [{ selector: 'stanza-batch', provider: first }] });
	const providers = StandaloneServices.get(ILanguageFeaturesService).hoverProvider;

	assert.deepEqual(providers.ordered(model), [first]);
	batch.replace({ hovers: [{ selector: 'stanza-batch', provider: second }] });
	assert.deepEqual(providers.ordered(model), [second]);
});

test("standalone languages API feeds the shared editor registries", async () => {
	stanza.languages.register({ id: 'stanza-public-test', extensions: ['.stanza-public'] });
	using configuration = stanza.languages.setLanguageConfiguration('stanza-public-test', { comments: { lineComment: '//' } });
	using provider = stanza.languages.registerHoverProvider('stanza-public-test', {
		provideHover: () => ({ contents: ['Public hover'] }),
	});
	const services = StandaloneServices.initialize();
	assert.equal(services.languageService.resolveLanguageId({ resource: URI.parse('file:///sample.stanza-public') }), 'stanza-public-test');
	assert.equal(services.languageConfigurationService.getLanguageConfiguration('stanza-public-test').comments?.lineCommentToken, '//');
	using model = stanza.editor.createModel('answer', 'stanza-public-test', URI.parse('inmemory://stanza/public-api.stanza-public'));
	assert.equal(model instanceof stanza.TextModel, true);
	if (!(model instanceof stanza.TextModel)) throw new Error('Expected the standalone model implementation');
	const signal = new AbortController().signal;
	assert.deepEqual(await services.languageFeaturesService.hoverProvider.ordered(model)[0]!.provideHover({ ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), position: new stanza.Position(1, 2) }, signal), { contents: ['Public hover'] });
});

test("standalone completion providers execute in a live editor", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	let requests = 0;
	stanza.languages.register({ id: "stanza-completion-test" });
	using provider = stanza.languages.registerCompletionItemProvider('stanza-completion-test', {
		id: "standalone.test",
		provideCompletions: request => {
			requests += 1;
			assert.equal(request.context.kind, stanza.languages.LanguageCompletionTriggerKind.Invoke);
			return {
				items: [{
					id: "standalone-result",
					label: "standaloneResult",
					kind: stanza.languages.LanguageCompletionItemKind.Text,
					range: stanza.Range.fromPositions(request.position),
					insertText: "standaloneResult",
					insertTextFormat: stanza.languages.LanguageCompletionInsertTextFormat.PlainText,
				}],
				isIncomplete: false,
			};
		},
	});
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	using editor = stanza.editor.create(container, { language: "stanza-completion-test" });

	editor.focus();
	await editor.getAction('editor.action.triggerSuggest')!.run();
	await new Promise<void>(resolve => setImmediate(resolve));
	await new Promise<void>(resolve => setImmediate(resolve));

	assert.equal(requests, 1);
	assert.equal(container.querySelector(".stanza-editor-completion-option")?.textContent, "TextstandaloneResult");
	editor.dispose();
	dom.window.close();
});

test("standalone API registers URI and language identity with model lifecycle events", () => {
	using descriptions = stanza.languages.registerLanguages([
		{ description: { id: 'typescript', extensions: ['.ts'] } },
		{ description: { id: 'javascript', extensions: ['.js'] } },
	]);
	const resource = URI.parse("inmemory://stanza/registry.ts");
	const created: string[] = [];
	const disposed: string[] = [];
	const languages: string[] = [];
	using createListener = stanza.editor.onDidCreateModel(model => created.push(model.uri.toString()));
	using disposeListener = stanza.editor.onWillDisposeModel(model => disposed.push(model.uri.toString()));
	using languageListener = stanza.editor.onDidChangeModelLanguage(event => languages.push(`${event.oldLanguage}->${event.model.getLanguageId()}`));

	const model = stanza.editor.createModel("const value = 1;", "typescript", resource);
	assert.equal(stanza.editor.getModel(resource), model);
	assert.equal(model.getLanguageId(), "typescript");
	assert.deepEqual(created, [resource.toString()]);
	assert.throws(() => stanza.editor.createModel("duplicate", "typescript", resource), /already exists/);

	stanza.editor.setModelLanguage(model, "javascript");
	assert.deepEqual(languages, ["typescript->javascript"]);
	model.dispose();
	assert.equal(stanza.editor.getModel(resource), null);
	assert.deepEqual(disposed, [resource.toString()]);
});

test("standalone createModel infers language from URI or first line unless language is explicit", () => {
	using descriptions = stanza.languages.registerLanguages([
		{ description: { id: "stanza-uri-inferred", extensions: [".stanza-inferred"] } },
		{ description: { id: "stanza-first-line-inferred", firstLine: "^#!.*\\bstanza-inferred\\b" } },
	]);
	using uriModel = stanza.editor.createModel(
		"plain content",
		undefined,
		URI.parse("inmemory://stanza/model.stanza-inferred"),
	);
	using firstLineModel = stanza.editor.createModel(
		"#!/usr/bin/env stanza-inferred\nplain content",
		undefined,
		URI.parse("inmemory://stanza/script"),
	);
	using explicitModel = stanza.editor.createModel(
		"#!/usr/bin/env stanza-inferred",
		"plaintext",
		URI.parse("inmemory://stanza/explicit.stanza-inferred"),
	);

	assert.equal(uriModel.getLanguageId(), "stanza-uri-inferred");
	assert.equal(firstLineModel.getLanguageId(), "stanza-first-line-inferred");
	assert.equal(explicitModel.getLanguageId(), "plaintext");
});

test("standalone editors share caller-owned models and dispose independently", () => {
	const dom = createTestDom("<!doctype html><body><main></main><aside></aside></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const model = stanza.editor.createModel("shared", "plaintext", URI.parse("inmemory://stanza/shared.txt"));
	const createdEditors: unknown[] = [];
	using listener = stanza.editor.onDidCreateEditor(editor => createdEditors.push(editor));
	const first = stanza.editor.create(dom.window.document.querySelector<HTMLElement>("main")!, { model });
	const second = stanza.editor.create(dom.window.document.querySelector<HTMLElement>("aside")!, { model });

	assert.deepEqual(createdEditors, [first, second]);
	assert.equal(stanza.editor.getEditors().includes(first), true);
	assert.equal(stanza.editor.getEditors().includes(second), true);
	first.setValue("shared model");
	assert.equal(second.getValue(), "shared model");
	first.dispose();
	assert.equal(model.getValue(), "shared model");
	assert.equal(stanza.editor.getEditors().includes(first), false);

	second.dispose();
	assert.equal(model.getValue(), "shared model");
	model.dispose();
	dom.window.close();
});

test('standalone layout follows editor focus, geometry, and disposal', () => {
	const dom = createTestDom('<!doctype html><body><main></main><aside></aside></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const main = dom.window.document.querySelector<HTMLElement>('main')!;
	const aside = dom.window.document.querySelector<HTMLElement>('aside')!;
	const layout = StandaloneServices.get(ILayoutService);
	const first = stanza.editor.create(main, { value: 'first' });
	const second = stanza.editor.create(aside, { value: 'second' });
	const firstRoot = first.getContainerDomNode();
	const secondRoot = second.getContainerDomNode();
	const changes: HTMLElement[] = [];
	const resized: HTMLElement[] = [];
	using listeners = new DisposableStore();
	listeners.add(layout.onDidChangeActiveContainer(() => changes.push(layout.activeContainer)));
	listeners.add(layout.onDidLayoutContainer(event => resized.push(event.container)));

	try {
		assert.equal(layout.mainContainer, firstRoot);
		assert.deepEqual([...layout.containers], [firstRoot, secondRoot]);
		first.layout({ width: 200, height: 100 });
		assert.deepEqual(resized, [firstRoot]);
		second.focus();
		assert.equal(layout.activeContainer, secondRoot);
		assert.equal(layout.getContainer(dom.window as unknown as Window), secondRoot);
		second.dispose();
		assert.equal(layout.activeContainer, firstRoot);
		assert.deepEqual(changes, [secondRoot, firstRoot]);
	} finally {
		second.dispose();
		first.dispose();
		dom.window.close();
	}
});

test('standalone creation event exposes an assembled editor and caller-owned model', () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const model = stanza.editor.createModel('caller text', 'plaintext', URI.parse('inmemory://stanza/event-ready.txt'));
	const observations: unknown[] = [];
	using listener = stanza.editor.onDidCreateEditor(editor => observations.push({
		model: editor.getModel(),
		registered: stanza.editor.getEditors().includes(editor),
		mounted: container.contains(editor.getDomNode()),
		placeholder: editor.getContribution('editor.contrib.placeholderText') !== null,
		find: editor.getContribution('editor.contrib.findController') !== null,
		theme: container.getAttribute('data-color-theme'),
	}));
	const editor = stanza.editor.create(container, { model, placeholder: 'Start typing' });

	assert.deepEqual(observations, [{
		model,
		registered: true,
		mounted: true,
		placeholder: true,
		find: true,
		theme: 'ash-light',
	}]);
	editor.dispose();
	assert.equal(model.isDisposed(), false);
	assert.equal(container.querySelector('.stanza-editor'), null);
	assert.equal(container.getAttribute('data-color-theme'), null);
	model.dispose();
	dom.window.close();
});

test('standalone creation listener can release an implicit model and editor immediately', () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const resource = URI.parse('inmemory://stanza/event-dispose.txt');
	let observedModel: ReturnType<typeof stanza.editor.createModel> | null | undefined;
	using listener = stanza.editor.onDidCreateEditor(editor => {
		observedModel = editor.getModel();
		(editor as ReturnType<typeof stanza.editor.create>).dispose();
	});
	const editor = stanza.editor.create(container, { value: 'owned', resource });

	assert.equal(editor.getModel(), null);
	assert.equal(observedModel?.isDisposed(), true);
	assert.equal(stanza.editor.getModel(resource), null);
	assert.equal(stanza.editor.getEditors().includes(editor), false);
	assert.equal(container.querySelector('.stanza-editor'), null);
	assert.equal(container.getAttribute('data-color-theme'), null);
	dom.window.close();
});

test('standalone editor releases its eager contribution with the editor', () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	let created = 0;
	let disposed = 0;
	class TrackingContribution extends AbstractDisposable {
		constructor() { super(); created += 1; }
		protected override disposeCore(): void { disposed += 1; }
	}
	const editor = stanza.editor.create(container, {
		value: 'tracked',
		contributions: [{ id: 'editor.contrib.standaloneLifecycleTest', ctor: TrackingContribution, instantiation: EditorContributionInstantiation.Eager }],
	});

	assert.equal(created, 1);
	assert.ok(editor.getContribution('editor.contrib.standaloneLifecycleTest'));
	editor.dispose();
	assert.equal(disposed, 1);
	assert.equal(stanza.editor.getEditors().includes(editor), false);
	assert.equal(container.querySelector('.stanza-editor'), null);
	dom.window.close();
});

test("standalone editor owns only the implicit model it creates", () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const editor = stanza.editor.create(dom.window.document.querySelector<HTMLElement>("main")!, {
		value: "owned",
		language: "plaintext",
		resource: URI.parse("inmemory://stanza/owned.txt"),
	});
	const model = editor.getModel();
	assert.ok(model);

	editor.dispose();
	assert.equal(model.isDisposed(), true);
	assert.equal(createdWorkerCount, terminatedWorkerCount);
	assert.equal(stanza.editor.getModel(URI.parse("inmemory://stanza/owned.txt")), null);
	dom.window.close();
});

test('standalone editor releases an implicit model on switch and retains caller-owned replacements', () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const ownedResource = URI.parse('inmemory://stanza/switch-owned.txt');
	const caller = stanza.editor.createModel('caller', 'plaintext', URI.parse('inmemory://stanza/switch-caller.txt'));
	const editor = stanza.editor.create(container, { value: 'owned', resource: ownedResource });
	try {
		const owned = editor.getModel();
		assert.ok(owned);
		const root = editor.getDomNode();
		const modelEvents: string[] = [];
		using listener = editor.onDidChangeModel(event => modelEvents.push(`${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`));
		editor.setModel(caller);
		assert.deepEqual({
			ownedDisposed: owned.isDisposed(),
			ownedRegistered: stanza.editor.getModel(ownedResource) !== null,
			currentModel: editor.getModel(),
			rootRetained: editor.getDomNode() === root,
			registeredEditors: stanza.editor.getEditors().filter(candidate => candidate === editor).length,
		}, {
			ownedDisposed: true,
			ownedRegistered: false,
			currentModel: caller,
			rootRetained: true,
			registeredEditors: 1,
		});
		editor.setModel(null);
		assert.equal(editor.getModel(), null);
		assert.equal(caller.isDisposed(), false);
		editor.setModel(caller);
		assert.deepEqual(modelEvents, [
			`${ownedResource}->${caller.uri}`,
			`${caller.uri}->undefined`,
			`undefined->${caller.uri}`,
		]);
	} finally {
		editor.dispose();
		assert.equal(createdWorkerCount, terminatedWorkerCount);
		assert.equal(caller.isDisposed(), false);
		caller.dispose();
		dom.window.close();
	}
});

test('standalone editor rejects an unregistered replacement without disturbing its current model', () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const editor = stanza.editor.create(container, { value: 'current' });
	using unregistered = new stanza.TextModel('unregistered');
	try {
		const model = editor.getModel();
		assert.ok(model);
		assert.throws(() => editor.setModel(unregistered), /not registered/);
		assert.strictEqual(editor.getModel(), model);
		assert.equal(model.isDisposed(), false);
		assert.equal(container.querySelectorAll('.stanza-editor').length, 1);
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('standalone editors keep caller-owned models and selections isolated when one switches', () => {
	const dom = createTestDom('<!doctype html><body><main></main><aside></aside></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const firstModel = stanza.editor.createModel('shared', 'plaintext', URI.parse('inmemory://stanza/switch-shared.txt'));
	const secondModel = stanza.editor.createModel('other', 'plaintext', URI.parse('inmemory://stanza/switch-other.txt'));
	const switching = stanza.editor.create(dom.window.document.querySelector<HTMLElement>('main')!, { model: firstModel });
	const staying = stanza.editor.create(dom.window.document.querySelector<HTMLElement>('aside')!, { model: firstModel });
	try {
		switching.setModel(secondModel);
		firstModel.setValue('still shared');
		assert.deepEqual({
			switchingValue: switching.getValue(),
			stayingValue: staying.getValue(),
			firstDisposed: firstModel.isDisposed(),
			secondDisposed: secondModel.isDisposed(),
		}, {
			switchingValue: 'other',
			stayingValue: 'still shared',
			firstDisposed: false,
			secondDisposed: false,
		});
		switching.setValue('changed other');
		assert.equal(staying.getValue(), 'still shared');
		switching.setPosition(new stanza.Position(1, 5));
		staying.setPosition(new stanza.Position(1, 2));
		assert.deepEqual({ switchingColumn: switching.getPosition()?.column, stayingColumn: staying.getPosition()?.column }, { switchingColumn: 5, stayingColumn: 2 });
	} finally {
		switching.dispose();
		staying.dispose();
		assert.equal(firstModel.isDisposed(), false);
		assert.equal(secondModel.isDisposed(), false);
		firstModel.dispose();
		secondModel.dispose();
		dom.window.close();
	}
});

test("standalone editor rejects unregistered models and conflicting model options", () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	const model = new stanza.TextModel("unregistered");
	assert.throws(() => stanza.editor.create(dom.window.document.querySelector<HTMLElement>("main")!, { model }), /not registered/);
	model.dispose();

	const registered = stanza.editor.createModel("registered", "plaintext", URI.parse("inmemory://stanza/conflict.txt"));
	assert.throws(() => stanza.editor.create(dom.window.document.querySelector<HTMLElement>("main")!, { model: registered, value: "conflict" }), /cannot be combined/);
	registered.dispose();
	const lateConfigurations = new TestLanguageConfigurationService();
	const lateOverride = new LanguageFeaturesService();
	assert.throws(() => stanza.editor.create(dom.window.document.querySelector<HTMLElement>("main")!, {}, { languageFeaturesService: lateOverride }), /already initialized/);
	lateOverride.dispose();
	lateConfigurations.dispose();
	dom.window.close();
});
suite('standalone browser component', () => {
	const browserTests = useBrowserTests();

	test('product format on type responds to keyboard input and undoes with its trigger', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		try {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareProductFormatting('type'));
			await page.keyboard.type(';');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('ALPHA;');
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha');
		} finally { await page.evaluate(() => window.ashStandaloneIntegration.dispose()); }
	});

	test('product format on type handles Enter through the public typing event', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		try {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareProductFormatting('type'));
			await page.keyboard.press('Enter');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('ALPHA\n');
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha');
		} finally { await page.evaluate(() => window.ashStandaloneIntegration.dispose()); }
	});

	for (const locale of ['en', 'zh-CN'] as const) {
		test(`product formatter picker supports keyboard choice and reuses the language default in ${locale}`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			try {
				await page.evaluate(locale => {
					window.ashStandaloneIntegration.setActionMenuLanguage(locale);
					window.ashStandaloneIntegration.prepareProductFormatting('choice');
				}, locale);
				const formatted = page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.formatDocument'));
				const picker = page.locator('.ash-quick-pick:visible');
				const input = picker.getByRole('combobox');
				await expect(input).toHaveAttribute('placeholder', locale === 'zh-CN' ? '选择格式化程序' : 'Select a Formatter');
				await input.fill(locale === 'zh-CN' ? '配置默认格式化程序' : 'Configure Default Formatter');
				await input.press('Enter');
				await expect(input).toHaveAttribute('placeholder', locale === 'zh-CN' ? '选择 plaintext 的默认格式化程序' : 'Select the Default Formatter for plaintext');
				await input.fill('Second formatter');
				await input.press('Enter');
				await formatted;
				await expect(picker).toHaveCount(0);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toMatchObject({ value: 'SECOND', focused: true });
				await page.keyboard.press('ControlOrMeta+z');
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha');
				await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.formatDocument'));
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('SECOND');
				await expect(picker).toHaveCount(0);
			} finally { await page.evaluate(() => window.ashStandaloneIntegration.dispose()); }
		});
	}

	test('editor auto scrollbars hide while text retains focus and reveal on hover or scrolling', async function () {
		const { page } = browserTests;

		await page.clock.install();
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareScrollGeometry(100));
		const editor = page.locator('#caller > .stanza-editor');
		const input = editor.locator('.stanza-editor-input');
		const track = editor.locator('.ash-scrollbar-track-vertical');
		await expect(input).toBeFocused();
		await page.mouse.move(900, 600);
		await expect(track).toHaveCSS('opacity', '0');
		await editor.hover();
		await expect(track).toHaveCSS('opacity', '1');
		await page.clock.runFor(800);
		await expect(track).toHaveCSS('opacity', '1');
		await page.mouse.move(900, 600);
		await expect(track).toHaveCSS('opacity', '0');
		await input.press('PageDown');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readScrollGeometry().logicalTop)).toBeGreaterThan(0);
		await expect(track).toHaveCSS('opacity', '1');
		await expect(track).toHaveCSS('opacity', '0');
		await expect(input).toBeFocused();
		// Keyboard users can still see and operate the scrollbar itself.
		await track.focus();
		await expect(track).toHaveCSS('opacity', '1');
		await expect(track).toHaveCSS('outline-style', 'solid');
		await track.press('ArrowDown');
		await expect(track).toBeFocused();
		await track.press('End');
		await expect.poll(() => track.evaluate(element => element.getAttribute('aria-valuenow') === element.getAttribute('aria-valuemax'))).toBe(true);
		await track.press('Home');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readScrollGeometry().logicalTop)).toBe(0);
		await editor.hover();
		await page.mouse.wheel(0, 180);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readScrollGeometry().logicalTop)).toBeGreaterThan(0);
		await page.mouse.move(900, 600);
		await page.clock.runFor(800);
		await input.focus();
		await expect(track).toHaveCSS('opacity', '0');
		await editor.hover();
		const thumb = track.locator('.ash-scrollbar-thumb');
		await thumb.hover();
		await page.mouse.down();
		try {
			await page.mouse.move(900, 600);
			await page.clock.runFor(800);
			await expect(track).toHaveClass(/active/);
			await expect(track).toHaveCSS('opacity', '1');
		} finally {
			await page.mouse.up();
		}
		await expect(track).toHaveCSS('opacity', '0');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('editor context menu runs navigation, rename and formatting through the focused editor', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		expect(errors).toEqual([]);
		const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
		for (const command of ['Go to Definition', 'Go to Declaration', 'Go to Type Definition', 'Go to Implementations', 'Go to References']) {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
			await input.press('Shift+F10');
			await page.getByRole('menuitem', { name: command, exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().selection)).toBe('[1,7 -> 1,11]');
			await expect(input).toBeFocused();
		}
		await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
		await input.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Rename Symbol', exact: true }).locator('.ash-menu-keybinding')).toBeVisible();
		await page.getByRole('menuitem', { name: 'Rename Symbol', exact: true }).click();
		const rename = page.getByRole('textbox', { name: 'New symbol name', exact: true });
		await expect(rename).toBeFocused();
		await rename.fill('gamma');
		await rename.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('gamma beta alpha');
		await input.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha beta alpha');
		for (const [command, value] of [['Format Document', 'formatted'], ['Format Selection', 'selection beta alpha']]) {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
			await input.press('Shift+F10');
			await page.getByRole('menuitem', { name: command, exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(value);
			await expect(input).toBeFocused();
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('editor context menu supports Peek keyboard navigation, matching edits and Copy As', async function () {
		const { page, context } = browserTests;

		await context.grantPermissions(['clipboard-read', 'clipboard-write']);
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
		const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
		await input.press('Shift+F10');
		const peek = page.getByRole('menuitem', { name: 'Peek', exact: true });
		await peek.focus();
		await peek.press('ArrowRight');
		const callHierarchy = page.getByRole('menuitem', { name: 'Peek Call Hierarchy', exact: true });
		await expect(callHierarchy).toBeFocused();
		await callHierarchy.press('ArrowDown');
		await page.getByRole('menuitem', { name: 'Peek Type Hierarchy', exact: true }).press('ArrowDown');
		const definition = page.getByRole('menuitem', { name: 'Peek Definition', exact: true });
		await expect(definition).toBeFocused();
		await definition.press('Enter');
		await expect(page.locator('.stanza-editor-language-preview')).toBeVisible();
		await expect(page.locator('.stanza-editor-language-locations button').first()).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(page.locator('.stanza-editor-language-preview')).toHaveCount(0);
		await expect(input).toBeFocused();
		await input.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Change All Occurrences', exact: true }).click();
		await page.keyboard.insertText('gamma');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('gamma beta gamma');
		await input.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha beta alpha');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(false));
		await input.press('Shift+F10');
		await page.getByRole('menuitem', { name: 'Copy As', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Copy with Syntax Highlighting', exact: true }).click();
		await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('alpha');
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('editor context menu filters refactor and source actions before applying the selected edit', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
		for (const [command, kind] of [['Refactor...', 'refactor.extract'], ['Source Action...', 'source.organizeImports']]) {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
			await input.press('Shift+F10');
			await page.getByRole('menuitem', { name: command, exact: true }).click();
			const actions = page.locator('.ash-action-widget').getByRole('menuitem');
			await expect(actions).toHaveCount(1);
			await page.getByRole('menuitem', { name: `Apply ${kind}`, exact: true }).click();
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(`${kind} beta alpha`);
			await expect(input).toBeFocused();
			await input.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha beta alpha');
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('editor context menu opens and expands the call and type hierarchy with keyboard focus', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const input = page.locator('#caller .stanza-editor-input[aria-label="caller.txt"]');
		for (const [command, expansion, child] of [['Peek Call Hierarchy', 'Callers for alpha', 'caller'], ['Peek Type Hierarchy', 'Supertypes for alpha', 'base']]) {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
			await input.press('Shift+F10');
			await page.getByRole('menuitem', { name: 'Peek', exact: true }).click();
			await page.getByRole('menuitem', { name: command, exact: true }).click();
			await expect(page.locator('.stanza-editor-language-hierarchy-item').first()).toBeFocused();
			await page.getByRole('button', { name: expansion, exact: true }).click();
			await expect(page.locator('.stanza-editor-language-hierarchy-item')).toHaveText(['alpha', child]);
			await page.keyboard.press('Escape');
			await expect(page.locator('.stanza-editor-language-hierarchy')).toHaveCount(0);
			await expect(input).toBeFocused();
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('editor context menu follows language, provider, selection and read-only state', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
		for (const change of ['language', 'provider', 'readonly', 'selection'] as const) {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
			await page.evaluate(change => window.ashStandaloneIntegration.changeEditorContextMenuState(change), change);
			await input.press('Shift+F10');
			await expect(page.getByRole('menuitem', { name: 'Format Selection', exact: true })).toHaveCount(0);
			if (change !== 'selection') {
				await expect(page.getByRole('menuitem', { name: 'Rename Symbol', exact: true })).toHaveCount(0);
				await expect(page.getByRole('menuitem', { name: 'Refactor...', exact: true })).toHaveCount(0);
				await expect(page.getByRole('menuitem', { name: 'Source Action...', exact: true })).toHaveCount(0);
			}
			await expect(page.getByRole('menuitem', { name: 'Go to Definition', exact: true })).toHaveCount(change === 'readonly' || change === 'selection' ? 1 : 0);
			await page.keyboard.press('Escape');
			await expect(input).toBeFocused();
		}
		await page.evaluate(() => window.ashStandaloneIntegration.changeEditorContextMenuState('other'));
		const other = page.locator('#owned > .stanza-editor .stanza-editor-input').first();
		await other.press('Shift+F10');
		await expect(page.getByRole('menuitem', { name: 'Go to Definition', exact: true })).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(other).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone text preserves leading, internal, and trailing whitespace across themes', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const lines = ['xxxxxxxxxx', '    xxxxxx', '\txxxxxx', '\t\txx', ' \t xxxxx', 'xx  xxxxxx', 'xxxxxxxxx '];
		await page.evaluate(value => window.ashStandaloneIntegration.prepareGuides(value), lines.join('\n'));
		const renderedLines = page.locator('#caller .view-line .stanza-editor-line-text');
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), theme);
			await expect.poll(() => renderedLines.allTextContents()).toEqual(lines);
			const widths = await renderedLines.evaluateAll(elements => elements.map(element => {
				const range = document.createRange();
				range.selectNodeContents(element);
				return range.getBoundingClientRect().width;
			}));
			expect(widths[0]).toBeGreaterThan(0);
			for (const width of widths) {
				expect(Math.abs(width - widths[0]!)).toBeLessThan(1);
			}
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('rendered hints set horizontal scroll bounds and minimap and glyph lanes reuse their owners', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html?contributionsOff');
		const result = await page.evaluate(() => window.ashStandaloneIntegration.exerciseRenderOwnership());
		expect(result.injectedWidth).toBeGreaterThan(4000);
		expect(result.scrollWidth).toBeGreaterThanOrEqual(result.injectedWidth);
		expect(result.scrollLeft).toBeGreaterThan(4000);
		expect({ left: result.clearedScrollLeft, width: result.clearedScrollWidth }).toEqual({ left: 0, width: 300 });
		expect({ cursor: result.cursorScans, resize: result.resizeScans }).toEqual({ cursor: 0, resize: 0 });
		expect(result.minimapCanvas).toEqual(result.configuredCanvas);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone Worker mirrors models, calls its host, and releases its transport', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const result = await page.evaluate(() => window.ashStandaloneIntegration.runStandaloneWebWorker());
		expect(result.initial.map(model => model.value)).toEqual(['caller', 'second']);
		expect(result.changed.map(model => model.value)).toEqual(['changed in main thread', 'second']);
		expect(result.changed[0]!.version).toBeGreaterThan(result.initial[0]!.version);
		expect(result.host).toBe('host:hello');
		expect(result.transferred).toEqual({ detached: 0, bytes: [3, 7, 11] });
		expect(result.afterRemoval.map(model => model.value)).toEqual(['changed in main thread']);
		expect(result.disposed).toBe(true);
		expect(errors).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone editor shows the themed outline while its input is focused', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const editor = page.locator('#caller .stanza-editor');
		await page.locator('#caller .stanza-editor-input').focus();
		await expect(editor).toHaveCSS('outline-style', 'solid');
		await expect(editor).toHaveCSS('outline-color', /^rgb/);
		expect(await editor.evaluate(node => getComputedStyle(node).getPropertyValue('--ash-focusBorder').trim())).not.toBe('');
		await page.evaluate(() => (document.activeElement as HTMLElement).blur());
		await expect(editor).toHaveCSS('outline-style', 'none');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone token themes recolor text and retain matching colors when copied', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('plain'));
		const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
		await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
		await expect(alpha).toHaveCSS('font-style', 'italic');
		const first = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
		expect(first.colors).toEqual(['#123456', '#654321']);
		expect(first.styles).toEqual([1, 0]);
		expect(first.html).toContain('#123456');
		expect(first.html).toContain('font-style: italic');
		await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('token-theme-second'));
		await expect(alpha).toHaveCSS('color', 'rgb(35, 69, 103)');
		await expect(alpha).toHaveCSS('font-weight', '700');
		await expect(alpha).toHaveCSS('font-style', 'normal');
		const second = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
		expect(second.colors).toEqual(['#234567', '#765432']);
		expect(second.styles).toEqual([2, 0]);
		expect(second.html).toContain('#234567');
		await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
		await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('standalone token inspector follows the caret and closes on Escape or model removal', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('plain'));
		await expect(page.locator('#caller .stanza-editor-token').filter({ hasText: 'alpha' })).toHaveCSS('color', 'rgb(18, 52, 86)');
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('F1');
		const picker = page.locator('#caller .ash-quick-pick');
		await picker.getByRole('combobox').fill('Inspect Tokens');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('Developer: Inspect Tokens');
		await page.keyboard.press('Enter');
		const inspector = page.locator('#caller .stanza-editor-inspect-tokens');
		await expect(inspector).toBeVisible();
		await expect(inspector).toHaveCSS('font-family', /system-ui/);
		await expect(inspector.locator('code')).toHaveCSS('font-family', /ui-monospace/);
		await expect(inspector).toContainText('entity.member');
		await expect(inspector).toContainText('alpha');
		await expect(inspector).toContainText('#123456');
		await expect(inspector).toHaveAttribute('role', 'status');
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('token-theme-second'));
		await expect(inspector).toContainText('#234567');
		await page.evaluate(() => window.ashStandaloneIntegration.setTokenInspectionPosition(8));
		await expect(inspector).toContainText('comment.line');
		await expect(inspector).toContainText('beta');
		await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('ash-high-contrast-dark'));
		const surface = await inspector.evaluate(node => {
			const style = getComputedStyle(node);
			return { background: style.backgroundColor, border: style.borderStyle };
		});
		expect(surface.background).not.toBe('rgba(0, 0, 0, 0)');
		expect(surface.border).toBe('solid');
		await page.keyboard.press('Escape');
		await expect(inspector).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.inspectTokens'));
		await expect(inspector).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.detachTokenInspectionModel());
		await expect(inspector).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('standalone token inspector shows Monarch and embedded scopes', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch'));
		await expect(page.locator('#caller .stanza-editor-token').filter({ hasText: 'alpha' })).toHaveCSS('color', 'rgb(18, 52, 86)');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.inspectTokens'));
		const inspector = page.locator('#caller .stanza-editor-inspect-tokens');
		await expect(inspector).toContainText('entity.member');
		await page.evaluate(() => window.ashStandaloneIntegration.setTokenInspectionPosition(10));
		await expect(inspector).toContainText('comment');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());

		await page.reload();
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch-embedded'));
		await expect(page.locator('#caller .stanza-editor-token').filter({ hasText: 'alpha' })).toHaveCSS('color', 'rgb(18, 52, 86)');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.inspectTokens'));
		const embeddedInspector = page.locator('#caller .stanza-editor-inspect-tokens');
		await page.evaluate(() => window.ashStandaloneIntegration.setTokenInspectionPosition(3));
		await expect(embeddedInspector).toContainText('monarch-child');
		await expect(embeddedInspector).toContainText('entity.member');
		await page.evaluate(() => window.ashStandaloneIntegration.setTokenInspectionPosition(9));
		await expect(embeddedInspector).toContainText('comment.line');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone encoded tokens use the supplied palette and font metadata', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('encoded'));
		const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
		await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
		await expect(alpha).toHaveCSS('font-weight', '700');
		const tokens = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
		expect(tokens.colors).toEqual(['#123456', '#abcdef']);
		expect(tokens.styles).toEqual([2, 0]);
		expect(tokens.html).toContain('#abcdef');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone language activation registers a tokenizer once when the model changes language', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('activation'));
		const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
		await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme().factoryCalls)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
		await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('standalone Monarch updates following lines after editing a comment boundary', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch'));
		const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
		const beta = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'beta' });
		await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
		await expect(beta).toHaveCSS('color', 'rgb(101, 67, 33)');
		await page.evaluate(() => window.ashStandaloneIntegration.removeMonarchCommentStart());
		await expect(beta).not.toHaveCSS('color', 'rgb(101, 67, 33)');
		await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('token-theme-second'));
		await expect(alpha).toHaveCSS('color', 'rgb(35, 69, 103)');
		await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
		await expect(page.locator('#caller .view-line .stanza-editor-token')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('standalone Monarch activates embedded token providers and returns to the host language', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch-embedded'));
		const alpha = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'alpha' });
		const beta = page.locator('#caller .view-line .stanza-editor-token').filter({ hasText: 'beta' });
		await expect(alpha).toHaveCSS('color', 'rgb(18, 52, 86)');
		await expect(beta).toHaveCSS('color', 'rgb(101, 67, 33)');
		const tokens = await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme());
		expect(tokens.languages).toEqual(['monarch-host', 'monarch-child', 'monarch-child', 'monarch-host']);
		expect(tokens.factoryCalls).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('standalone colorizer renders escaped themed HTML without creating an editor model', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('monarch'));
		const models = await page.evaluate(() => window.ashStandaloneIntegration.colorizePreview());
		expect(models.modelsAfter).toBe(models.modelsBefore);
		const preview = page.locator('#colorized-preview');
		await expect(preview.locator('span').filter({ hasText: /^alpha$/ })).toHaveCSS('color', 'rgb(18, 52, 86)');
		await expect(preview.locator('span').filter({ hasText: '/* hello */' })).toHaveCSS('color', 'rgb(101, 67, 33)');
		await expect(preview.locator('img, script')).toHaveCount(0);
		await expect(preview.locator('br')).toHaveCount(1);
		expect(await preview.textContent()).toContain('alpha\u00a0\u00a0\u00a0<img');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		await expect(preview).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	for (const removed of [false, true]) {
		test(`standalone lazy token provider resolves once and respects removal=${removed}`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareTokenTheme('lazy'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme().factoryCalls)).toBe(1);
			if (removed) {
				await page.evaluate(() => window.ashStandaloneIntegration.removeTokenProvider());
			}
			await page.evaluate(() => window.ashStandaloneIntegration.finishTokenProvider());
			const tokens = page.locator('#caller .view-line .stanza-editor-token');
			if (removed) {
				await expect(tokens).toHaveCount(0);
			} else {
				await expect(tokens.filter({ hasText: 'alpha' })).toHaveCSS('color', 'rgb(18, 52, 86)');
			}
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readTokenTheme().factoryCalls)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test('standalone command picker executes editor actions, restores focus and follows editor disposal', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('F1');
		const picker = page.locator('#caller .ash-quick-pick');
		const query = picker.getByRole('combobox');
		await expect(picker).toHaveCSS('font-family', /system-ui/);
		await expect(picker).toHaveCSS('font-size', '13px');
		await expect(query).toBeFocused();
		const bounds = await picker.boundingBox();
		const editorBounds = await page.locator('#caller').boundingBox();
		expect(bounds!.width).toBeLessThanOrEqual(editorBounds!.width);
		await page.keyboard.press('Escape');
		await expect(picker).toHaveCount(0);
		await expect(input).toBeFocused();
		const ownedInput = page.locator('#owned .stanza-editor-input');
		await ownedInput.focus();
		await page.keyboard.press('F1');
		await expect(page.locator('#owned .ash-quick-pick')).toBeVisible();
		await expect(page.locator('#caller .ash-quick-pick')).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(ownedInput).toBeFocused();
		await input.focus();
		await page.keyboard.press('F1');
		await query.fill('editor.action.gotoLine');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveCount(1);
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(page.locator('#caller .stanza-editor-goto-line-input')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await page.keyboard.press('F1');
		await expect(query).toBeFocused();
		await query.fill('editor.action.gotoOffset');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveCount(1);
		await page.keyboard.press('Enter');
		await expect(page.locator('#caller .stanza-editor-goto-line-input')).toHaveAttribute('aria-label', 'Character offset');
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await page.keyboard.press('F1');
		await expect(query).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		await expect(page.locator('.ash-quick-input-host')).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	test('standalone Quick Access help filters navigation actions and runs the selected action', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('F1');
		const picker = page.locator('#caller .ash-quick-pick');
		const query = picker.getByRole('combobox');
		await expect(query).toHaveAttribute('placeholder', 'Type > for commands, ? for help, or @ for symbols');
		await query.fill('?');
		await expect(picker).toHaveAttribute('aria-label', 'Quick Access Help');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveCount(4);
		await query.fill('?line');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('? Go to Line/Column...');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(page.locator('#caller .stanza-editor-goto-line-input')).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await page.keyboard.press('F1');
		await query.fill('?symbol');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('? Go to Symbol...');
		await page.keyboard.press('Enter');
		await expect(picker.getByRole('combobox', { name: 'Go to Symbol' })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await page.keyboard.press('F1');
		await query.fill('?command');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('? Command Palette');
		await page.keyboard.press('Enter');
		await expect(picker.getByRole('combobox', { name: 'Command Palette' })).toBeFocused();
		await query.fill('editor.action.gotoOffset');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('Go to Offset...');
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone Quick Access switches command and symbol prefixes without losing the query', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLanguageRequest('symbols'));
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('F1');
		const picker = page.locator('#caller .ash-quick-pick');
		const query = picker.getByRole('combobox');
		await query.fill('>editor.action.gotoOffset');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('Go to Offset...');
		await query.fill('?symbol');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('? Go to Symbol...');
		await query.fill('@sec');
		await expect(picker).toHaveCount(1);
		await expect(picker.getByRole('combobox', { name: 'Go to Symbol' })).toHaveValue('sec');
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('second');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(input).toBeFocused();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe('[1,7 -> 1,13]');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone symbol search returns to help and commands and cancels its request', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLanguageRequest('symbols'));
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('ControlOrMeta+Shift+o');
		const picker = page.locator('#caller .ash-quick-pick');
		await picker.getByRole('combobox', { name: 'Go to Symbol' }).fill('?line');
		await expect(picker).toHaveCount(1);
		await expect(picker).toHaveAttribute('aria-label', 'Quick Access Help');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('? Go to Line/Column...');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests()))[0]?.aborted).toBe(true);
		await picker.getByRole('combobox').fill('>editor.action.gotoOffset');
		await expect(picker).toHaveAttribute('aria-label', 'Command Palette');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('Go to Offset...');
		await page.keyboard.press('Enter');
		await expect(page.locator('#caller .stanza-editor-goto-line-input')).toHaveAttribute('aria-label', 'Character offset');
		await page.keyboard.press('Escape');
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone command registrations execute through the command service and release their shortcuts', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareStandaloneCommands());
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('F8');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneCommands())).toEqual({ calls: ['key'], registered: true });
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runStandaloneCommand('payload'))).toBe('payload');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneCommands())).toEqual({ calls: ['key', 'alias:payload'], registered: true });
		await page.evaluate(() => window.ashStandaloneIntegration.releaseStandaloneCommands());
		await page.keyboard.press('F8');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneCommands())).toEqual({ calls: ['key', 'alias:payload'], registered: false });
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone dynamic keybindings apply conditions, arguments and blockers', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareStandaloneCommands();
			window.ashStandaloneIntegration.prepareDynamicKeybindings();
		});
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('F7');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneCommands())).calls).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.setDynamicKeybindingContext(true));
		await page.keyboard.press('F7');
		await page.keyboard.press('F8');
		await page.keyboard.press('F5');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneCommands())).calls).toEqual(['alias:batch', 'alias:single']);
		await page.evaluate(() => window.ashStandaloneIntegration.setDynamicKeybindingContext(false));
		await page.keyboard.press('F8');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneCommands())).calls).toEqual(['alias:batch', 'alias:single', 'key']);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone editor actions reach the picker, menu, shortcuts and command service until disposed', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareStandaloneAction());
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneAction())).toEqual({
			calls: [], available: true, menu: true, registered: true,
		});
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('F6');
		await page.evaluate(() => window.ashStandaloneIntegration.runStandaloneAction('disabled'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneAction())).calls).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.setDynamicKeybindingContext(true));
		await page.keyboard.press('F6');
		await page.evaluate(() => window.ashStandaloneIntegration.runStandaloneAction('direct'));
		await page.evaluate(() => window.ashStandaloneIntegration.runStandaloneActionCommand('command'));
		await page.keyboard.press('F1');
		const picker = page.locator('#caller .ash-quick-pick');
		await picker.getByRole('combobox').fill('Standalone test action');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('Standalone test action');
		await page.keyboard.press('Enter');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneAction())).calls).toEqual([
			'caller:key', 'caller:direct', 'caller:command', 'caller:key',
		]);
		await page.evaluate(() => window.ashStandaloneIntegration.releaseStandaloneAction());
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readStandaloneAction())).toEqual({
			calls: ['caller:key', 'caller:direct', 'caller:command', 'caller:key'], available: false, menu: false, registered: false,
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	for (const scheme of ['dark', 'light'] as const) {
		test(`standalone command picker toggles ${scheme} high contrast and restores the theme`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), `ash-${scheme}`);
			await page.locator('#caller .stanza-editor-input').focus();
			for (const expected of [`ash-high-contrast-${scheme}`, `ash-${scheme}`]) {
				await page.keyboard.press('F1');
				const picker = page.locator('#caller .ash-quick-pick');
				await picker.getByRole('combobox').fill('editor.action.toggleHighContrast');
				await expect(picker.locator('.ash-quick-pick-row-label')).toHaveCount(1);
				await page.keyboard.press('Enter');
				await expect(page.locator('#caller')).toHaveAttribute('data-color-theme', expected);
				await expect(page.locator('#owned')).toHaveAttribute('data-color-theme', expected);
				await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
			}
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test('an initially empty standalone editor attaches, edits and releases a shared model', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const empty = await page.evaluate(() => window.ashStandaloneIntegration.createEmptyEditor());
		expect(empty).toEqual({ modelsAdded: 0, model: null, id: expect.any(String) });
		await expect(page.locator('#empty .stanza-editor-input')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.attachEmptyEditor());
		await expect(page.locator('#empty .stanza-editor-input')).toBeFocused();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.type(' attached');
		await expect(page.locator('#caller .view-line')).toContainText(['caller attached']);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.detachEmptyEditor())).toEqual({ value: 'caller attached', modelDisposed: false });
		await expect(page.locator('#empty .stanza-editor-input')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		await expect(page.locator('#empty')).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	async function stickyDefinitionPoint(page: Page): Promise<{ x: number; y: number; column: number; }> {
		const text = page.locator('#caller .stanza-editor-sticky-scroll-text').last();
		await expect(text).toHaveText('  function inner() {');
		return text.evaluate(element => {
			const text = element.firstElementChild!.firstChild!;
			const offset = text.textContent!.indexOf('inner') + 2;
			const range = document.createRange();
			range.setStart(text, offset);
			range.setEnd(text, offset + 1);
			const bounds = range.getBoundingClientRect();
			return { x: bounds.left + bounds.width / 4, y: bounds.top + bounds.height / 2, column: offset + 1 };
		});
	}

	suite('contribution lifecycle', () => {
		teardown(async function () {
			const { page } = browserTests;

			await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
		});

		for (const reason of ['escape', 'language', 'selection', 'blur', 'readonly', 'provider', 'dispose'] as const) {
			test(`completion ${reason} cancels a pending request and rejects its late result`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
				await page.keyboard.press('Control+Space');
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
				if (reason === 'escape') {
					await page.keyboard.press('Escape');
				} else {
					await page.evaluate(reason => window.ashStandaloneIntegration.changeContributionState(reason), reason);
				}
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([{ languageId: 'typescript', aborted: true }]);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
				await expect(page.locator('#caller .stanza-editor-completion:not([hidden])')).toHaveCount(0);
				await expect(page.locator('#caller .stanza-editor-input[aria-activedescendant]')).toHaveCount(0);
			});
		}

		test('completion provider removal hides resolved suggestions and prevents acceptance', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
			await page.keyboard.press('Control+Space');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-completion')).toBeVisible();
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('provider'));
			await expect(page.locator('#caller .stanza-editor-completion')).toBeHidden();
			await page.keyboard.press('Enter');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).not.toContain('result');
		});

		for (const scrolled of [false, true]) {
			test(`completion and public coordinates include the gutter with scroll=${scrolled}`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
				await page.evaluate(scrolled => window.ashStandaloneIntegration.prepareCompletionGeometry(scrolled), scrolled);
				await page.keyboard.press('Control+Space');
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
				await expect(page.locator('#caller .stanza-editor-completion')).toBeVisible();
				const geometry = await page.evaluate(() => window.ashStandaloneIntegration.readCompletionGeometry());
				expect(geometry.contentLeft).toBeGreaterThan(0);
				expect(Math.abs(geometry.api.left - geometry.caret.left)).toBeLessThan(2);
				expect(Math.abs(geometry.widget.left - geometry.caret.left)).toBeLessThan(2);
				expect(Math.abs(geometry.widget.top - geometry.api.top - geometry.api.height)).toBeLessThan(2);
				expect(geometry.textLeft).toBeGreaterThan(0);
			});
		}

		for (const kind of ['colors', 'highlights'] as const) {
			for (const initiallyOff of [false, true]) {
				test(`${kind} responds to option toggles from initiallyOff=${initiallyOff} and rejects disabled requests`, async function () {
					const { page } = browserTests;

					await page.goto(initiallyOff ? '/standalone.html?contributionsOff' : '/standalone.html');
					await page.evaluate(kind => window.ashStandaloneIntegration.prepareContributionRequests(kind), kind);
					if (initiallyOff) {
						expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
						await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: true } : { occurrencesHighlight: 'singleFile' }), kind);
					}
					if (kind === 'highlights' && !initiallyOff) await page.keyboard.press('ArrowRight');
					await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
					await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
					await expect.poll(() => page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(2);
					await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: false } : { occurrencesHighlight: 'off' }), kind);
					expect(await page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(0);
					await page.keyboard.press('ArrowRight');
					await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: true, colorDecoratorsLimit: 1 } : { occurrencesHighlight: 'singleFile' }), kind);
					await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
					await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: false } : { occurrencesHighlight: 'off' }), kind);
					expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests()))[1]!.aborted).toBe(true);
					await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
					expect(await page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(0);
					await page.evaluate(kind => window.ashStandaloneIntegration.updateContributionOptions(kind === 'colors' ? { colorDecorators: true } : { occurrencesHighlight: 'singleFile' }), kind);
					await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(3);
					await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(2));
					await expect.poll(() => page.evaluate(kind => window.ashStandaloneIntegration.readContributionDecorations()[kind], kind)).toBe(kind === 'colors' ? 1 : 2);
				});
			}
		}

		for (const initiallyOff of [false, true]) {
			test(`folding toggles from initiallyOff=${initiallyOff}, restores hidden text and cancels providers`, async function () {
				const { page } = browserTests;

				await page.goto(initiallyOff ? '/standalone.html?contributionsOff' : '/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('folding'));
				if (initiallyOff) {
					expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
					await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: true }));
				}
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ showFoldingControls: 'always' }));
				await expect(page.locator('#caller .ash-icon-folding-expanded').first()).toBeVisible();
				await expect(page.locator('#caller .ash-icon-folding-expanded .ash-icon').first()).toBeVisible();
				await page.locator('#caller .ash-icon-folding-expanded').first().click();
				await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(0);
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: false }));
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).every(request => request.aborted)).toBe(true);
				await page.evaluate(async () => {
					const requests = window.ashStandaloneIntegration.readContributionRequests();
					for (let index = 0; index < requests.length; index++) await window.ashStandaloneIntegration.finishContributionRequest(index);
				});
				await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(1);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionDecorations())).folding).toBe(0);
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: true }));
				await expect(page.locator('#caller .ash-icon-folding-expanded').first()).toBeVisible();
				await page.locator('#caller .ash-icon-folding-expanded').first().click();
				await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(0);
			});
		}

		for (const initiallyOff of [false, true]) {
			test(`sticky headers toggle from initiallyOff=${initiallyOff} and keep focused nodes through layout`, async function () {
				const { page } = browserTests;

				await page.goto(initiallyOff ? '/standalone.html?contributionsOff' : '/standalone.html');
				await page.evaluate(() => {
					window.ashStandaloneIntegration.updateContributionOptions({ folding: true });
					window.ashStandaloneIntegration.prepareStickyHeaders();
				});
				const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
				if (initiallyOff) {
					await expect(buttons).toHaveCount(0);
					await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { enabled: true } }));
				}
				await expect(buttons).toHaveCount(2);
				await expect(buttons.last()).toBeInViewport();
				const button = await buttons.first().elementHandle();
				await buttons.first().focus();
				await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590));
				expect(await button!.evaluate(element => ({ connected: element.isConnected, focused: document.activeElement === element }))).toEqual({ connected: true, focused: true });
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { maxLineCount: 1 } }));
				await expect(buttons).toHaveCount(1);
				await expect(buttons.first()).toHaveText('function outer() {');
				expect(await button!.evaluate(element => document.activeElement === element)).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { enabled: false } }));
				await expect(buttons).toHaveCount(0);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { enabled: true, maxLineCount: 5 } }));
				await expect(buttons).toHaveCount(2);
			});
		}

		test('sticky scroll commands navigate headers, reveal the selection and return focus', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareStickyHeaders());
			const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
			await expect(buttons).toHaveCount(2);
			await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
			await expect(buttons.last()).toBeFocused();
			await page.keyboard.press('ArrowUp');
			await expect(buttons.first()).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(buttons.last()).toBeFocused();
			await page.keyboard.press('Escape');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
			await page.keyboard.press('Enter');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).line).toBe(2);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200));
			await expect(buttons).toHaveCount(2);
			await buttons.first().click();
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).line).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200));
			await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
			await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.toggleStickyScroll'));
			await expect(buttons).toHaveCount(0);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		});

		test('sticky scroll uses declaration lines, live line height and horizontal scroll options', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareStickySymbols());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
			await expect(buttons).toHaveText(['class Outer {', '  method() {']);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ lineHeight: 28 }));
			await expect.poll(() => buttons.first().evaluate(element => element.getBoundingClientRect().height)).toBe(28);
			await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200, 80));
			await expect(buttons.first().locator('.stanza-editor-sticky-scroll-text')).toHaveCSS('text-indent', '-80px');
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ stickyScroll: { scrollWithEditor: false } }));
			await expect(buttons.first().locator('.stanza-editor-sticky-scroll-text')).toHaveCSS('text-indent', '0px');
			for (const theme of ['ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), theme);
				await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.focusStickyScroll'));
				await expect(buttons.last()).toBeFocused();
				const focus = await buttons.last().evaluate(element => {
					const style = getComputedStyle(element);
					return { width: style.outlineWidth, color: style.outlineColor, token: style.getPropertyValue('--ash-focusBorder').trim() };
				});
				expect(focus.width).toBe('1px');
				expect(focus.token).not.toBe('');
			}
		});

		for (const reason of ['text', 'language', 'provider', 'model', 'dispose'] as const) {
			test(`sticky scroll cancels stale outline requests on ${reason}`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareStickySymbols());
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests()))[0]!.aborted).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
				await expect(page.locator('#caller .stanza-editor-sticky-scroll-item')).not.toHaveText(['class Outer {', '  method() {']);
			});
		}

		test('sticky scroll selects the widest outline and preserves its source until removal', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('initial'));
			const headers = page.locator('#caller .stanza-editor-sticky-scroll-text');
			await expect(headers).toHaveText(['  function inner() {', '    item 0']);
			await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('larger'));
			await expect(headers).toHaveText(['  function inner() {', '    item 0']);
			await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('remove'));
			await expect(headers).toHaveText(['function outer() {', '  function inner() {']);
		});

		test('sticky scroll uses indentation when every outline is empty and folding is disabled', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.changeStickySources('initial'));
			await page.evaluate(() => {
				window.ashStandaloneIntegration.updateContributionOptions({ folding: false });
				return window.ashStandaloneIntegration.changeStickySources('empty');
			});
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-text')).toHaveText(['function outer() {', '  function inner() {']);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).hidden).toEqual([]);
		});

		test('sticky scroll clips a leaving scope and excludes headers inside hidden lines', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.updateContributionOptions({ lineHeight: 20 });
				window.ashStandaloneIntegration.prepareStickyHeaders();
			});
			const buttons = page.locator('#caller .stanza-editor-sticky-scroll-item');
			await expect(buttons).toHaveCount(2);
			const state = await page.evaluate(() => window.ashStandaloneIntegration.readStickyState());
			await page.evaluate(end => window.ashStandaloneIntegration.scrollSticky(end * 20 - 30), state.ends[1]!);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyState().offset)).toBe(-10);
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-row').last()).toHaveCSS('clip-path', 'inset(10px 0px 0px)');
			await page.evaluate(end => window.ashStandaloneIntegration.scrollSticky(end * 20 - 20), state.ends[1]!);
			await expect(buttons).toHaveCount(1);
			await page.evaluate(() => {
				window.ashStandaloneIntegration.scrollSticky(200);
				window.ashStandaloneIntegration.hideStickyLines(2, 4);
			});
			await expect(buttons).toHaveText(['function outer() {']);
		});

		test('sticky scroll follows live syntax and semantic tokens without changing header identity', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareStickyHeaders();
				window.ashStandaloneIntegration.setStickySyntax('#123456');
			});
			const header = page.locator('#caller .stanza-editor-sticky-scroll-item').first();
			const token = header.locator('.stanza-editor-token').first();
			await expect(token).toHaveCSS('color', 'rgb(18, 52, 86)');
			await expect(token).toHaveCSS('font-weight', '700');
			const bodyToken = page.locator('#caller .view-line .stanza-editor-token').first();
			await expect(bodyToken).toHaveCSS('color', 'rgb(18, 52, 86)');
			await header.focus();
			const retained = await header.elementHandle();
			await page.evaluate(() => window.ashStandaloneIntegration.setStickySyntax('#654321'));
			await expect(token).toHaveCSS('color', 'rgb(101, 67, 33)');
			expect(await retained!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
			await page.evaluate(() => {
				window.ashStandaloneIntegration.setStickySyntax(null);
				window.ashStandaloneIntegration.setSemanticProvider('variable');
			});
			await expect(token).toHaveClass(/token-variable/);
			await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider('function'));
			await expect(token).toHaveClass(/token-function/);
		});

		test('sticky scroll reduces its line limit with editor height and restores focus when no header fits', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.updateContributionOptions({ lineHeight: 20 });
				window.ashStandaloneIntegration.prepareStickyHeaders();
			});
			const headers = page.locator('#caller .stanza-editor-sticky-scroll-item');
			await expect(headers).toHaveCount(2);
			await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590, 40));
			await expect(headers).toHaveCount(1);
			await headers.first().focus();
			await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590, 20));
			await expect(headers).toHaveCount(0);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590, 180));
			await expect(headers).toHaveCount(2);
		});

		test('sticky scroll keeps line numbers fixed and updates numbering with the cursor and options', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareStickySymbols());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			const numbers = page.locator('#caller .stanza-editor-sticky-scroll-number');
			await expect(numbers).toHaveText(['2', '4']);
			const left = await numbers.first().evaluate(element => element.getBoundingClientRect().left);
			await page.evaluate(() => window.ashStandaloneIntegration.scrollSticky(200, 80));
			expect(await numbers.first().evaluate(element => element.getBoundingClientRect().left)).toBe(left);
			await page.evaluate(() => {
				window.ashStandaloneIntegration.updateContributionOptions({ lineNumbers: 'relative' });
				window.ashStandaloneIntegration.moveGutterCaret(20, 1);
			});
			await expect(numbers).toHaveText(['18', '16']);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ lineNumbers: 'off' }));
			await expect(numbers).toHaveText(['', '']);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ lineNumbers: line => `L${line}` }));
			await expect(numbers).toHaveText(['L2', 'L4']);
		});

		test('sticky scroll folding controls update the shared hidden ranges by mouse and keyboard', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareStickyHeaders();
				window.ashStandaloneIntegration.updateContributionOptions({ showFoldingControls: 'always' });
			});
			const folds = page.locator('#caller .stanza-editor-sticky-scroll-folding');
			await expect(folds).toHaveCount(2);
			await expect(folds.last().locator('.ash-icon')).toHaveCount(1);
			expect(await folds.last().evaluate(element => {
				const icon = element.querySelector('.ash-icon');
				return icon !== null && getComputedStyle(icon, '::before').color === getComputedStyle(element).color;
			})).toBe(true);
			const expandedIcon = await folds.last().locator('.ash-icon').getAttribute('data-ash-icon-id');
			await folds.last().click();
			await expect(folds.last()).toHaveAttribute('aria-expanded', 'false');
			await expect(folds.last().locator('.ash-icon')).toHaveCount(1);
			expect(await folds.last().locator('.ash-icon').getAttribute('data-ash-icon-id')).not.toBe(expandedIcon);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyState().hidden)).toEqual([[3, 83]]);
			await folds.last().focus();
			await page.keyboard.press('Enter');
			await expect(folds.last()).toHaveAttribute('aria-expanded', 'true');
			await expect(folds.last()).toBeFocused();
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyState().hidden)).toEqual([]);
			await page.keyboard.press('Space');
			await expect(folds.last()).toHaveAttribute('aria-expanded', 'false');
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ showFoldingControls: 'never' }));
			await expect(folds.last()).toBeHidden();
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-item').last()).toBeFocused();
		});

		test('sticky scroll Shift hover previews the ending line and restores the same focused header', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareStickyHeaders());
			const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
			await expect(header).toHaveText('  function inner() {');
			await header.focus();
			const retained = await header.elementHandle();
			const end = await page.evaluate(() => window.ashStandaloneIntegration.readStickyState().ends[1]!);
			await header.hover();
			await page.keyboard.down('Shift');
			await expect(header).toHaveAttribute('data-line-number', String(end));
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-number').last()).toHaveText(String(end));
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-folding').last()).toBeHidden();
			await page.keyboard.up('Shift');
			await expect(header).toHaveText('  function inner() {');
			expect(await retained!.evaluate(element => element.isConnected && document.activeElement === element)).toBe(true);
			await header.click({ modifiers: ['Shift'] });
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyState())).line).toBe(end);
		});

		for (const modifier of ['ControlOrMeta', 'Alt'] as const) {
			test(`sticky scroll ${modifier} click sends the clicked column to definition navigation`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(modifier => {
					window.ashStandaloneIntegration.prepareLanguageRequest('definition');
					window.ashStandaloneIntegration.prepareStickyHeaders();
					if (modifier === 'Alt') window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' });
				}, modifier);
				const point = await stickyDefinitionPoint(page);
				await page.keyboard.down(modifier);
				await page.mouse.click(point.x, point.y);
				await page.keyboard.up(modifier);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDefinitionPosition())).toEqual({ lineNumber: 2, column: point.column });
				await page.evaluate(() => {
					const index = window.ashStandaloneIntegration.readLanguageRequests().findIndex(request => !request.aborted);
					return window.ashStandaloneIntegration.finishLanguageRequest(index);
				});
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 13 });
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
			});

			test(`sticky scroll ${modifier} hover underlines definitions without moving the selection`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(modifier => {
					window.ashStandaloneIntegration.prepareLanguageRequest('definition');
					window.ashStandaloneIntegration.prepareStickyHeaders();
					window.ashStandaloneIntegration.setStickyTheme(modifier === 'Alt' ? 'ash-high-contrast-light' : 'ash-high-contrast-dark');
					if (modifier === 'Alt') window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' });
				}, modifier);
				const point = await stickyDefinitionPoint(page);
				const selection = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
				await page.mouse.move(point.x, point.y);
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([]);
				await page.keyboard.down(modifier);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
				await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
				const token = page.locator('#caller .stanza-editor-sticky-scroll-text > span').last();
				await expect(token).toHaveCSS('text-decoration-line', 'underline');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(selection);
				await page.mouse.move(point.x + 1, point.y);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).length).toBe(1);
				await page.keyboard.up(modifier);
				await expect(token).toHaveCSS('text-decoration-line', 'none');
			});
		}

		for (const reason of ['pointer', 'modifier', 'text', 'language', 'provider', 'model', 'dispose', 'layout', 'option'] as const) {
			test(`sticky scroll definition hover cancels on ${reason} and rejects its late result`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => {
					window.ashStandaloneIntegration.prepareLanguageRequest('definition');
					window.ashStandaloneIntegration.prepareStickyHeaders();
				});
				const point = await stickyDefinitionPoint(page);
				await page.mouse.move(point.x, point.y);
				await page.keyboard.down('ControlOrMeta');
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
				if (reason === 'pointer') {
					await page.mouse.move(0, 0);
				} else if (reason === 'modifier') {
					await page.keyboard.up('ControlOrMeta');
				} else if (reason === 'layout') {
					await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(590));
				} else if (reason === 'option') {
					await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' }));
				} else {
					await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
				}
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests()))[0]!.aborted).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
				await expect(page.locator('#caller .stanza-editor-sticky-scroll.definition-link')).toHaveCount(0);
			});
		}

		test('sticky scroll definition hover leaves text unchanged when no definition exists', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareLanguageRequest('definition', true);
				window.ashStandaloneIntegration.prepareStickyHeaders();
			});
			const point = await stickyDefinitionPoint(page);
			await page.keyboard.down('ControlOrMeta');
			await page.mouse.move(point.x, point.y);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			await expect(page.locator('#caller .stanza-editor-sticky-scroll.definition-link')).toHaveCount(0);
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-text').last()).toHaveText('  function inner() {');
		});

		test('sticky scroll definition navigation cancels when its source editor changes model', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareLanguageRequest('definition');
				window.ashStandaloneIntegration.prepareStickyHeaders();
			});
			const text = page.locator('#caller .stanza-editor-sticky-scroll-text').last();
			await expect(text).toHaveText('  function inner() {');
			await text.locator('span').first().click({ modifiers: ['ControlOrMeta'] });
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().filter(request => !request.aborted).length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('model'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).every(request => request.aborted)).toBe(true);
			const position = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
			await page.evaluate(async () => {
				for (const [index] of window.ashStandaloneIntegration.readLanguageRequests().entries()) {
					await window.ashStandaloneIntegration.finishLanguageRequest(index);
				}
			});
			expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(position);
		});

		test('sticky scroll context menu restores focus, keeps the source editor and supports keyboard invocation', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareStickyHeaders();
				window.ashStandaloneIntegration.changeContributionState('blur');
			});
			const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
			await expect(header).toBeVisible();
			const position = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
			await header.click({ button: 'right' });
			const toggle = page.getByRole('menuitemcheckbox', { name: 'Toggle Editor Sticky Scroll' });
			await expect(toggle).toBeVisible();
			await expect(toggle).toHaveAttribute('aria-checked', 'true');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(position);
			await page.keyboard.press('Escape');
			await expect(header).toBeFocused();
			await page.keyboard.press('Shift+F10');
			await expect(toggle).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(page.locator('#caller .stanza-editor-sticky-scroll-item')).toHaveCount(0);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu())).toEqual({ callerEnabled: false, ownedEnabled: true, inChordMode: false });
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		});

		test('sticky scroll menu uses the active theme, reports action errors and dispatches registered chords', async function () {
			const { page } = browserTests;

			const notificationErrors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') notificationErrors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareStickyHeaders();
				window.ashStandaloneIntegration.prepareStickyMenu();
			});
			const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
			for (const theme of ['ash-high-contrast-dark', 'ash-high-contrast-light']) {
				await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), theme);
				await header.click({ button: 'right' });
				const menu = page.getByRole('menu');
				await expect(menu).toBeVisible();
				const colors = await menu.evaluate(element => {
					const style = getComputedStyle(element.parentElement!);
					return { background: style.backgroundColor, token: style.getPropertyValue('--ash-editor-background').trim(), position: style.position };
				});
				expect(colors.token).not.toBe('');
				expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
				expect(colors.position).toBe('fixed');
				await page.keyboard.press('Escape');
			}
			await header.click({ button: 'right' });
			await page.getByRole('menuitem', { name: 'Fail sticky command' }).click();
			await expect.poll(() => notificationErrors).toContain('Sticky command failed');
			await page.evaluate(() => window.ashStandaloneIntegration.runStickyCommand('editor.action.selectEditor'));
			await page.keyboard.press('F9');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu())).inChordMode).toBe(true);
			await page.keyboard.press('Escape');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu())).inChordMode).toBe(false);
			await page.keyboard.press('F9');
			await page.keyboard.press('F10');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readStickyMenu().callerEnabled)).toBe(false);
		});

		test('sticky scroll menu closes with its model and respects the contextmenu option', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareStickyHeaders();
				window.ashStandaloneIntegration.updateContributionOptions({ contextmenu: false });
			});
			const header = page.locator('#caller .stanza-editor-sticky-scroll-item').last();
			await header.click({ button: 'right' });
			await expect(page.getByRole('menu')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ contextmenu: true }));
			await header.click({ button: 'right' });
			await expect(page.getByRole('menu')).toBeVisible();
			await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('model'));
			await expect(page.getByRole('menu')).toHaveCount(0);
		});

		test('completion uses the new language and Escape stops incomplete refreshes', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('completion'));
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
			await page.keyboard.press('Control+Space');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([{ languageId: 'javascript', aborted: false }]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-completion')).toContainText('completion: javascript');
			await page.keyboard.press('Escape');
			await page.keyboard.type('z');
			await expect(page.locator('#caller .stanza-editor-completion:not([hidden])')).toHaveCount(0);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toHaveLength(1);
		});

		test('folding cancels old language requests and queries the current language after edits', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('folding'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBeGreaterThan(0);
			const count = await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length);
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().at(-1)?.languageId)).toBe('javascript');
			const requests = await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests());
			expect(requests.slice(0, count).every(request => request.aborted)).toBe(true);
			expect(requests.slice(count).every(request => request.languageId === 'javascript')).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('edit'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBeGreaterThan(requests.length);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).slice(count).every(request => request.languageId === 'javascript')).toBe(true);
		});

		for (const reason of ['language', 'provider', 'dispose'] as const) {
			test(`links ${reason} cancels an unresolved request`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('links'));
				const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
				await page.mouse.move(point.x, point.y);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
				await page.mouse.move(point.x + 1, point.y);
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toHaveLength(1);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeContributionState(reason), reason);
				const expected = [{ languageId: 'typescript', aborted: true }];
				if (reason === 'language') expected.push({ languageId: 'javascript', aborted: false });
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual(expected);
				await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
				await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(0);
			});
		}

		test('links discard cached targets when language changes', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.keyboard.down('ControlOrMeta');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('links'));
			const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
			await page.mouse.move(point.x, point.y);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
			await page.mouse.click(point.x, point.y);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
			await page.mouse.move(point.x + 1, point.y);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
			await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
			await page.mouse.click(point.x + 1, point.y);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual(['https://example.invalid/javascript']);
			await page.keyboard.up('ControlOrMeta');
		});

		test('CodeLens removes old language commands and rejects late responses', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('codelens'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-codelens')).toHaveText('lens: typescript');
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('language'));
			await expect(page.locator('#caller .stanza-editor-codelens')).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('off'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests()))[1]!.aborted).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
			await expect(page.locator('#caller .stanza-editor-codelens')).toHaveCount(0);
		});

		test('CodeLens can be enabled after creation and toggled without restoring stale widgets', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html?codeLensOff');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('codelens'));
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('on'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
			await expect(page.locator('#caller .stanza-editor-codelens')).toHaveText('lens: typescript');
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('off'));
			await expect(page.locator('#caller .stanza-editor-codelens')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('on'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(2);
			await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(1));
			await expect(page.locator('#caller .stanza-editor-codelens')).toHaveText('lens: typescript');
		});

		test('selection highlighting responds to configuration without moving the selection', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('hover'));
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('selection'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readSelectionHighlights())).toBe(1);
			const state = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('off'));
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readSelectionHighlights())).toBe(0);
			await page.evaluate(() => window.ashStandaloneIntegration.changeContributionState('on'));
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readSelectionHighlights())).toBe(1);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(state);
		});

		test('hover clears documentation when the next word has no result', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('hover'));
			const first = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
			await page.mouse.move(first.x, first.y);
			await expect(page.locator('.stanza-editor-hover:not([hidden])')).toHaveText('alpha documentation');
			await expect(page.locator('.stanza-editor-hover').first()).toHaveCSS('font-family', /system-ui/);
			const next = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(9));
			await page.mouse.move(next.x, next.y);
			await expect(page.locator('.stanza-editor-hover').first()).toBeHidden();
			await expect(page.locator('.stanza-editor-hover').first()).toHaveText('');
		});
	});

	suite('inlay hints', () => {
		test('inlay hints reserve inline label and padding width without changing model text', async function () {
			const { page } = browserTests;
			const testInfo = browserTests.info;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.registerBundledThemes());
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'parameter:', { paddingLeft: true, paddingRight: true }));
			const hint = page.locator('#caller .stanza-editor-inlay-hint');
			await expect(hint).toBeVisible();
			const geometry = await page.evaluate(() => {
				const hint = document.querySelector<HTMLElement>('#caller .stanza-editor-inlay-hint')!;
				const line = document.querySelector('#caller .stanza-editor-line-text')!;
				const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
				let node: Node | null;
				while ((node = walker.nextNode())) {
					const offset = node.textContent!.indexOf('value');
					if (offset < 0) continue;
					const range = document.createRange();
					range.setStart(node, offset);
					range.setEnd(node, offset + 5);
					return { hintRight: hint.getBoundingClientRect().right, valueLeft: range.getBoundingClientRect().left, top: range.getBoundingClientRect().top, height: range.getBoundingClientRect().height, label: hint.textContent };
				}
				throw new Error('Missing original value after inlay rendering');
			});
			expect(geometry.label).toBe('\u00a0parameter:\u00a0');
			expect(geometry.valueLeft).toBeGreaterThanOrEqual(geometry.hintRight - 1);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe('call(value)');
			for (const theme of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light'] as const) {
				await page.evaluate(theme => window.ashStandaloneIntegration.setActionMenuTheme(theme), theme);
				await expect(hint).toBeVisible();
				await testInfo.attach(theme, { body: await page.locator('#caller').screenshot(), contentType: 'image/png' });
			}
			await page.mouse.click(geometry.valueLeft + 1, geometry.top + geometry.height / 2);
			await page.keyboard.type('x');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('call(xvalue)');
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('call(value)');
		});

		teardown(async function () {
			const { page } = browserTests;

			await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
		});

		for (const mode of ['on', 'offUnlessPressed', 'onUnlessPressed'] as const) {
			test(`inlay visibility follows ${mode}, modifier release and window blur without querying providers again`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(mode => {
					window.ashStandaloneIntegration.updateContributionOptions({ inlayHints: { enabled: mode } });
					window.ashStandaloneIntegration.prepareInlayRequests();
				}, mode);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
				await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'value:'));
				const hint = page.locator('#caller .stanza-editor-inlay-hint');
				await expect(hint).toBeVisible({ visible: mode !== 'offUnlessPressed' });
				await page.keyboard.down('Control');
				await page.keyboard.down('Alt');
				await expect(hint).toBeVisible({ visible: mode !== 'onUnlessPressed' });
				await page.keyboard.up('Alt');
				await page.keyboard.up('Control');
				await expect(hint).toBeVisible({ visible: mode !== 'offUnlessPressed' });
				await page.keyboard.down('Control');
				await page.keyboard.down('Alt');
				await page.evaluate(() => window.dispatchEvent(new Event('blur')));
				await expect(hint).toBeVisible({ visible: mode !== 'offUnlessPressed' });
				await page.keyboard.up('Alt');
				await page.keyboard.up('Control');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toHaveLength(1);
			});
		}

		test('late provider registration displays hints and layout retains their nodes', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
			const editorState = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toEqual([{
				text: 'call(value)', languageId: 'plaintext', resource: 'inmemory://stanza/caller.txt', range: '[1,1 -> 1,12]', aborted: false,
			}]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'value:'));
			const hint = page.locator('#caller .stanza-editor-inlay-hint');
			await expect(hint).toHaveText('value:');
			await hint.hover();
			await expect(hint).toHaveAttribute('title', 'inlay detail');
			const node = await hint.elementHandle();
			await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('layout'));
			expect(await node!.evaluate(element => element.isConnected)).toBe(true);
			const box = await hint.boundingBox();
			expect(box!.width).toBeGreaterThan(0);
			expect(box!.height).toBeGreaterThan(0);
			await expect(hint).toHaveCount(1);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toHaveLength(1);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(editorState);
		});

		test('edits clear old hints immediately and coalesce requests for the latest text', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'old:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('old:');
			await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('text'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveCount(0);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().map(request => request.text))).toEqual(['call(value)', 'bacall(value)']);
			await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('language'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().map(request => [request.languageId, request.aborted]))).toEqual([
				['plaintext', false], ['plaintext', true], ['typescript', false],
			]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(2, 'current:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('current:');
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(1, 'stale:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('current:');
		});

		test('shortening the document removes hints before layout reads obsolete positions', async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'obsolete:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('obsolete:');
			await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('shrink'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveCount(0);
			expect(errors).toEqual([]);
		});

		for (const reason of ['provider', 'off', 'contribution', 'model', 'dispose'] as const) {
			test(`${reason} removes rendered hints and stops requests`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
				await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'visible:'));
				await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('visible:');
				await page.evaluate(reason => window.ashStandaloneIntegration.changeInlayState(reason), reason);
				await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveCount(0);
				if (reason !== 'dispose') {
					await page.evaluate(() => {
						window.ashStandaloneIntegration.changeInlayState('text');
						window.ashStandaloneIntegration.changeInlayState('language');
					});
				}
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toHaveLength(1);
			});

			test(`${reason} aborts an unresolved provider`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeInlayState(reason), reason);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests()))[0]!.aborted).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'late:'));
				await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveCount(0);
			});
		}

		test('initially disabled hints can be enabled and toggled during a request', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html?inlayHintsOff');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareInlayRequests());
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests())).toEqual([]);
			await page.evaluate(() => window.ashStandaloneIntegration.changeInlayState('on'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(() => {
				window.ashStandaloneIntegration.changeInlayState('off');
				window.ashStandaloneIntegration.changeInlayState('on');
			});
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(2);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(1, 'enabled:'));
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'cancelled:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('enabled:');
		});

		test('a failing provider does not discard hints from another provider', async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareInlayRequests();
				window.ashStandaloneIntegration.addBrokenInlayProvider();
			});
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlayRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishInlayRequest(0, 'healthy:'));
			await expect(page.locator('#caller .stanza-editor-inlay-hint')).toHaveText('healthy:');
			expect(errors.some(message => message.includes('inlay provider failed'))).toBe(true);
		});
	});

	test('Open Link opens the provider target from the keyboard without hovering', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLinkCandidates());
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('ControlOrMeta+Home');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLinkAtCursor())).toBe('https://resolved.test');
		await page.keyboard.press('F1');
		const picker = page.locator('#caller .ash-quick-pick');
		await picker.getByRole('combobox').fill('Open Link');
		await expect(picker.locator('.ash-quick-pick-row-label').filter({ hasText: /^Open Link$/u })).toBeVisible();
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual(['https://resolved.test/']);
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('detected document links reach the editor opener without a language provider', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLinks());
		const link = page.locator('#caller .view-line > span > span').filter({ hasText: 'https://example.test/path' }).first();
		await expect(link).toBeVisible();
		const bounds = await link.boundingBox();
		expect(bounds).not.toBeNull();
		const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
		await page.mouse.move(point.x, point.y);
		await page.mouse.click(point.x, point.y);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
		await page.keyboard.down('ControlOrMeta');
		await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
		await page.mouse.click(point.x, point.y);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual(['https://example.test/path']);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('plain text'));
		await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(0);
		await page.keyboard.up('ControlOrMeta');
	});

	test('links combine provider targets and detected URLs and honor disabled state and modifiers', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ links: false });
			window.ashStandaloneIntegration.prepareLinkCandidates();
		});
		const first = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(4));
		await page.keyboard.down('ControlOrMeta');
		await page.mouse.click(first.x, first.y);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ links: true }));
		await page.mouse.move(first.x + 1, first.y);
		await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
		await page.mouse.click(first.x + 1, first.y);
		await page.keyboard.up('ControlOrMeta');
		await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(0);
		const second = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(23));
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: 'ctrlCmd' }));
		await page.keyboard.down('Alt');
		await page.mouse.move(second.x, second.y);
		await expect(page.locator('#caller .stanza-editor-link-target')).toHaveCount(1);
		await page.mouse.click(second.x, second.y);
		await page.keyboard.up('Alt');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual(['https://resolved.test/', 'https://two.test/']);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('links disabling aborts pending results and prevents further provider requests', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareContributionRequests('links'));
		const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(3));
		await page.mouse.move(point.x, point.y);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ links: false }));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests()))[0]!.aborted).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
		await page.keyboard.down('ControlOrMeta');
		await page.mouse.click(point.x + 1, point.y);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readOpenedLinks())).toEqual([]);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toHaveLength(1);
		await page.keyboard.up('ControlOrMeta');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('semantic provider replacement and removal update rendered token styles', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider('variable'));
		const variable = page.locator('#caller .view-lines .token-variable.token-modifier-readonly');
		await expect(variable).toHaveText('caller');
		await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider('function'));
		await expect(page.locator('#caller .view-lines .token-function.token-modifier-readonly')).toHaveText('caller');
		await expect(variable).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.setSemanticProvider(null));
		await expect(page.locator('#caller .view-lines .token-modifier-readonly')).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	test('File drop stays available to the host without reading content', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runFileDrop())).toEqual({
			value: 'alpha',
			dragOverHandled: false,
			dropHandled: false,
			fileReads: 0,
		});
	});

	for (const enabled of [true, false]) {
		test(`text drop respects dropIntoEditor.enabled=${enabled}`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			expect(await page.evaluate(enabled => window.ashStandaloneIntegration.runTextDrop(enabled), enabled)).toEqual({
				value: enabled ? 'alpha dropped' : 'alpha',
				dragOverHandled: enabled,
				dropHandled: enabled,
			});
			if (enabled) {
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			}
		});
	}

	test('occurrence shortcuts and actions share the same selections and edit transaction', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('echo echo echo', [2]));
		await page.keyboard.press('ControlOrMeta+d');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]']);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.addSelectionToNextFindMatch'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]', '[1,6 -> 1,10]']);
		await page.keyboard.press('ControlOrMeta+Shift+l');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toHaveLength(3);
		await page.keyboard.type('X');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('X X X');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('echo echo echo');
	});

	test('cursor actions share line-end and adjacent cursor operations', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareMulticursor());
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorAtEndOfEachLineSelected'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,6 -> 1,6]', '[2,5 -> 2,5]']);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('alpha\nbeta\ngamma', [2]));
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorBelow'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toHaveLength(2);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertCursorAbove'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta\ngamma');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('echo echo', [2]));
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.selectHighlights'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,5]', '[1,6 -> 1,10]']);
	});

	test('multicursor registration handles line-end cursors and one undoable edit', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareMulticursor());
		await page.keyboard.press('Alt+Shift+i');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,6 -> 1,6]', '[2,5 -> 2,5]']);
		await page.keyboard.type('X');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alphaX\nbetaX');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta');
	});

	test('bracket navigation shares the controller with its action for multiple cursors', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one) [two]', [1, 7]));
		await page.keyboard.press('ControlOrMeta+Shift+Backslash');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,5 -> 1,5]', '[1,11 -> 1,11]']);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.jumpToBracket'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,1]', '[1,7 -> 1,7]']);
	});

	test('model bracket decorations reach the viewport and follow per-editor color settings', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('{([])}', [1]));
		const colors = page.locator('#caller .view-line [class*="stanza-editor-bracket-level-"]');
		await expect(colors).toHaveCount(6);
		expect(await colors.evaluateAll(elements => elements.map(element => [...element.classList].find(value => value.startsWith('stanza-editor-bracket-level-'))))).toEqual([1, 2, 3, 3, 2, 1].map(level => `stanza-editor-bracket-level-${level}`));
		await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(false, false));
		await expect(colors).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(true, true));
		await expect(page.locator('#caller .view-line .stanza-editor-bracket-level-1')).toHaveCount(6);
		await page.keyboard.press('ArrowRight');
		await page.keyboard.type('x');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('{x([])}');
		await expect(colors).toHaveCount(6);
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('{([])}');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareBrackets('{\n  value\n}', [1]);
			window.ashStandaloneIntegration.configureBracketColors(false, false);
		});
		await expect(colors).toHaveCount(0);
		await expect(page.locator('#caller .stanza-editor-bracket-guide')).not.toHaveCount(0);
	});

	test('indent guides show blank-line depth, theme strokes and preserve pointer editing', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareGuides('root\n\tchild\n\n    sibling\nroot');
			window.ashStandaloneIntegration.moveGutterCaret(3, 1);
		});
		const row = (line: number) => page.locator(`#caller .view-overlay-line[data-line-index="${line}"]`);
		const guides = row(2).locator('.stanza-editor-indent-guide');
		await expect(guides).toHaveCount(2);
		await expect(guides.last()).toHaveClass(/active/);
		await expect(page.locator('#caller .stanza-editor-symbol-icon')).toHaveCount(0);
		const positions = (line: number) => row(line).locator('.stanza-editor-indent-guide').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
		expect(await positions(2)).toEqual(await positions(1));
		expect(await positions(2)).toEqual(await positions(3));
		for (const [scheme, inactive, active] of [
			['Dark', 'rgb(69, 69, 69)', 'rgb(144, 144, 144)'],
			['Light', 'rgb(196, 196, 196)', 'rgb(112, 112, 112)'],
			['HighContrastDark', 'rgb(160, 160, 160)', 'rgb(255, 255, 255)'],
			['HighContrastLight', 'rgb(102, 102, 102)', 'rgb(0, 0, 0)'],
		] as const) {
			await page.evaluate(scheme => window.ashStandaloneIntegration.setGuideTheme(scheme), scheme);
			await expect(guides.first()).toHaveCSS('border-left-color', inactive);
			await expect(guides.last()).toHaveCSS('border-left-color', active);
			await expect(guides.first()).toHaveCSS('border-left-width', '1px');
			await expect(guides.last()).toHaveCSS('border-left-width', '1px');
		}
		await page.evaluate(() => window.ashStandaloneIntegration.setGuideTheme('Dark', {
			'editorIndentGuide.background1': '#123456', 'editorIndentGuide.activeBackground1': '#abcdef',
		}));
		await expect(guides.first()).toHaveCSS('border-left-color', 'rgb(18, 52, 86)');
		await expect(guides.last()).toHaveCSS('border-left-color', 'rgb(171, 205, 239)');
		await expect(guides.last()).toHaveCSS('pointer-events', 'none');
		const bounds = await guides.last().boundingBox();
		expect(bounds?.height).toBe(20);
		expect(await guides.last().evaluate(element => element.closest('[aria-hidden="true"]') !== null)).toBe(true);
		await page.mouse.click(bounds!.x, bounds!.y + 10);
		await page.keyboard.type('x');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).value).toBe('root\n\tchild\nx\n    sibling\nroot');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).focused).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ guides: { indentation: false } }));
		await expect(page.locator('#caller .stanza-editor-indent-guide')).toHaveCount(0);
	});

	test('bracket guides use nesting themes, active strokes and half-line endpoints', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareGuides('{\n  [\n    value\n    ]\n  tail\n}');
			window.ashStandaloneIntegration.moveGutterCaret(3, 5);
		});
		const vertical = page.locator('#caller .stanza-editor-bracket-guide');
		const levelOne = page.locator('#caller .stanza-editor-bracket-guide.stanza-editor-guide-level-1');
		const levelTwo = page.locator('#caller .stanza-editor-bracket-guide.stanza-editor-guide-level-2');
		await expect(levelOne).toHaveCount(6);
		await expect(levelTwo).toHaveCount(3);
		await expect(page.locator('#caller .view-overlay-line[data-line-index="2"] .stanza-editor-indent-guide')).toHaveCount(0);
		await expect(levelTwo.first()).toHaveClass(/active/);
		await expect(levelOne.first()).toHaveCSS('border-left-width', '1px');
		await expect(levelTwo.first()).toHaveCSS('border-left-width', '1px');
		expect(await levelOne.evaluateAll(elements => elements.map(element => ({ height: element.getBoundingClientRect().height, top: (element as HTMLElement).style.top })))).toEqual([
			{ height: 10, top: '10px' }, ...Array(4).fill({ height: 20, top: '0px' }), { height: 10, top: '0px' },
		]);
		const horizontal = page.locator('#caller .stanza-editor-bracket-guide-horizontal.stanza-editor-guide-level-2');
		await expect(horizontal).toHaveCSS('border-top-width', '1px');
		expect((await horizontal.boundingBox())!.width).toBeGreaterThan(0);
		for (const [scheme, color] of [
			['Dark', 'rgb(198, 120, 221)'], ['Light', 'rgb(136, 65, 160)'],
			['HighContrastDark', 'rgb(255, 112, 232)'], ['HighContrastLight', 'rgb(136, 65, 160)'],
		] as const) {
			await page.evaluate(scheme => window.ashStandaloneIntegration.setGuideTheme(scheme), scheme);
			await expect(levelTwo.first()).toHaveCSS('border-left-color', color);
			await expect(horizontal).toHaveCSS('border-top-color', color);
			await expect(levelOne.first()).toHaveCSS('border-left-width', '1px');
			await expect(levelTwo.first()).toHaveCSS('border-left-width', '1px');
			await expect(horizontal).toHaveCSS('border-top-width', '1px');
		}
		await page.evaluate(() => window.ashStandaloneIntegration.setGuideTheme('Dark', {
			'editorBracketPairGuide.background1': '#123456', 'editorBracketPairGuide.activeBackground2': '#abcdef',
		}));
		await expect(levelOne.first()).toHaveCSS('border-left-color', 'rgb(18, 52, 86)');
		await expect(levelTwo.first()).toHaveCSS('border-left-color', 'rgb(171, 205, 239)');
		await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ guides: { bracketPairs: 'active', bracketPairsHorizontal: false } }));
		await expect(levelOne).toHaveCount(0);
		await expect(levelTwo).toHaveCount(3);
		await expect(horizontal).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.moveGutterCaret(5, 3));
		await expect(levelTwo).toHaveCount(0);
		await expect(levelOne).toHaveCount(6);
		await page.evaluate(() => window.ashStandaloneIntegration.configureBracketColors(true, true));
		await expect(levelTwo).toHaveCount(0);
		await expect(levelOne).toHaveCount(9);
		await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ guides: { bracketPairs: false } }));
		await expect(vertical).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides('({[]})'));
		await expect(vertical).toHaveCount(0);
	});

	test('wrapped indentation guides stay in the reserved indentation space', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareGuides(`    ${'word '.repeat(100)}`);
			window.ashStandaloneIntegration.configureGuides({ wordWrap: 'wordWrapColumn', wordWrapColumn: 24, wrappingIndent: 'same', guides: { bracketPairs: false } });
		});
		const rows = page.locator('#caller .view-line');
		await expect.poll(() => rows.count()).toBeGreaterThan(1);
		await expect(page.locator('#caller .view-overlay-line[data-line-index="1"] .stanza-editor-indent-guide')).toHaveCount(2);
		await page.evaluate(() => window.ashStandaloneIntegration.configureGuides({ wrappingIndent: 'none' }));
		await expect(page.locator('#caller .view-overlay-line[data-line-index="1"] .stanza-editor-indent-guide')).toHaveCount(0);
		await expect(page.locator('#caller .view-overlay-line[data-line-index="0"] .stanza-editor-indent-guide')).toHaveCount(2);
	});

	test('bracket guides follow block indentation without crossing function text', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareGuides('function example() {\n    call();\n}');
			window.ashStandaloneIntegration.moveGutterCaret(2, 10);
		});
		const vertical = page.locator('#caller .stanza-editor-bracket-guide');
		await expect(vertical).toHaveCount(3);
		await expect(vertical.first()).toHaveClass(/active/);
		const row = page.locator('#caller .view-overlay-line[data-line-index="0"]').filter({ has: page.locator('.stanza-editor-bracket-guide') });
		const horizontal = page.locator('#caller .stanza-editor-bracket-guide-horizontal');
		await expect(horizontal).toHaveCount(1);
		const opening = (await row.boundingBox())!;
		const connector = (await horizontal.boundingBox())!;
		expect(connector.y + connector.height).toBeCloseTo(opening.y + opening.height);
		const columns = await vertical.evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
		expect(columns).toEqual([columns[0], columns[0], columns[0]]);
		const text = (await page.locator('#caller .view-line').nth(1).locator('.stanza-editor-line-text').boundingBox())!;
		expect(columns[1]).toBeCloseTo(text.x);
		const indent = await page.locator('#caller .view-overlay-line[data-line-index="1"] .stanza-editor-indent-guide').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().x));
		expect(indent).not.toContain(columns[1]);
	});

	suite('scroll geometry separation', () => {
		async function readAfterFrames(page: Page): Promise<ReturnType<typeof window.ashStandaloneIntegration.readScrollGeometry>> {
			return page.evaluate(() => new Promise<ReturnType<typeof window.ashStandaloneIntegration.readScrollGeometry>>(resolve => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.ashStandaloneIntegration.readScrollGeometry())));
			}));
		}

		for (const mode of ['scroll', 'reveal'] as const) {
			test(`appending overflow reaches the tail through ${mode}`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await page.goto('/standalone.html?contributionsOff');
				try {
					await page.evaluate(() => window.ashStandaloneIntegration.prepareScrollGeometry(3));
					const before = await readAfterFrames(page);
					const immediate = await page.evaluate(mode => window.ashStandaloneIntegration.appendAndReveal(mode), mode);
					const settled = await readAfterFrames(page);
					await testInfo.attach('scroll-geometry.json', { body: JSON.stringify({ before, immediate, settled, events: await page.evaluate(() => window.ashStandaloneIntegration.readScrollGeometryEvents()) }, null, 2), contentType: 'application/json' });
					expect(settled).toEqual({ ...before, version: immediate.version, lineCount: 20, logicalTop: 234, domTop: 234, domHeight: 360, contentHeight: 360 });
					expect(immediate.version).toBeGreaterThan(before.version);
					await expect(page.locator('#caller .view-line').filter({ hasText: /^row-20$/ })).toBeVisible();
				} finally {
					await page.evaluate(() => window.ashStandaloneIntegration.dispose());
				}
			});
		}

		for (const close of ['Escape', 'command'] as const) {
			test(`Quick Pick ${close} preserves a stable editor viewport`, async function () {
				const { page } = browserTests;
				const testInfo = browserTests.info;

				await page.goto('/standalone.html?contributionsOff');
				try {
					await page.evaluate(() => window.ashStandaloneIntegration.prepareScrollGeometry(20));
					await readAfterFrames(page);
					await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(234));
					const before = await readAfterFrames(page);
					expect(before).toMatchObject({ logicalTop: 234, domTop: 234, focus: 'editor', caretLine: 1, lineCount: 20 });
					await page.evaluate(() => window.ashStandaloneIntegration.openScrollGeometryPicker());
					const input = page.locator('.ash-quick-pick-input input');
					await expect(input).toBeFocused();
					const open = await page.evaluate(() => window.ashStandaloneIntegration.readScrollGeometry());
					if (close === 'Escape') {
						await input.press('Escape');
					} else {
						await page.getByRole('option').filter({ has: page.getByText('Keep editor position', { exact: true }) }).click();
					}
					await expect(page.locator('.ash-quick-pick')).toHaveCount(0);
					const settled = await readAfterFrames(page);
					await testInfo.attach('scroll-geometry.json', { body: JSON.stringify({ before, open, settled, events: await page.evaluate(() => window.ashStandaloneIntegration.readScrollGeometryEvents()) }, null, 2), contentType: 'application/json' });
					expect(open).toEqual({ ...before, focus: 'picker' });
					expect(settled).toEqual({ ...before, commandExecutions: close === 'command' ? 1 : 0 });
				} finally {
					await page.evaluate(() => window.ashStandaloneIntegration.dispose());
				}
			});
		}
	});

	test('guide rows track folding and scrolling without retaining hidden lines', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareGuides(['{', '    child', '}', ...Array(50).fill('tail')].join('\n'));
			window.ashStandaloneIntegration.configureGuides({ showFoldingControls: 'always', scrollBeyondLastLine: false });
		});
		const guides = page.locator('#caller .stanza-editor-bracket-guide');
		await expect(guides).toHaveCount(3);
		await page.locator('#caller .ash-icon-folding-expanded').first().click();
		await expect(page.locator('#caller .ash-icon-folding-collapsed').first()).toBeVisible();
		await expect.poll(() => guides.count()).toBeLessThan(3);
		await expect(page.locator('#caller .view-line').filter({ hasText: 'child' })).toHaveCount(0);
		await page.locator('#caller .ash-icon-folding-collapsed').first().click();
		await expect(guides).toHaveCount(3);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(500));
		await expect(guides).toHaveCount(0);
		await expect(page.locator('#caller .stanza-editor-indent-guide')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
		await expect(guides).toHaveCount(3);
	});

	test('common text operations preserve multi-cursor joins, deletions and undo', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineJoin());
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.joinLines'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '😀 one two\r\nkeep\r\n三 four', selections: ['[3,2 -> 3,2]', '[1,7 -> 1,7]'] });
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.deleteLines'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '  two\r\nkeep\r\n  four', selections: ['[3,1 -> 3,1]', '[1,1 -> 1,1]'] });
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
	});

	for (const entry of ['shortcut', 'action'] as const) {
		test(`bracket removal via ${entry} is one undo step`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one) [two]', [1, 7]));
			if (entry === 'shortcut') await page.keyboard.press('ControlOrMeta+Alt+Backspace');
			else await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('one two');
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '(one) [two]', selections: ['[1,1 -> 1,1]', '[1,7 -> 1,7]'] });
		});
	}

	for (const entry of ['shortcut', 'action'] as const) {
		test(`bracket removal via ${entry} preserves unrelated selected text`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(value) keep', [1, [13, 9]]));
			if (entry === 'shortcut') await page.keyboard.press('ControlOrMeta+Alt+Backspace');
			else await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: 'value keep', selections: ['[1,1 -> 1,1]', '[1,11 -> 1,7]'] });
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: '(value) keep', selections: ['[1,1 -> 1,1]', '[1,13 -> 1,9]'] });
		});
	}

	test('bracket removal respects read-only state while navigation remains available', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareBrackets('(one)', [1], true));
		await page.keyboard.press('ControlOrMeta+Alt+Backspace');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.removeBrackets'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('(one)');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.jumpToBracket'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,5 -> 1,5]']);
	});

	test('document formatting uses a range-only provider and remains undoable', async function () {
		const { page } = browserTests;

		const workers: string[] = [];
		page.on('worker', worker => workers.push(worker.url()));
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runFormatting('range'))).toBe('ALPHA');
		expect(workers.some(url => /editorWebWorkerMain/u.test(url))).toBe(true);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting().value)).toBe('alpha');
	});

	test('line comment shortcuts share actions and preserve the primary selection below a secondary caret', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment());
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.keyboard.press('ControlOrMeta+/');
		const commented = { value: '// alpha\nbeta\n// gamma', selections: ['[3,7 -> 3,5]', '[1,5 -> 1,5]'] };
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(commented);
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.commentLine'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(commented);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	for (const kind of ['line', 'block'] as const) {
		test(`${kind} comment shortcuts honor spacing and toggle through the action`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment({ insertSpace: false, value: 'alpha' }));
			await page.keyboard.press(kind === 'line' ? 'ControlOrMeta+/' : 'Alt+Shift+a');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(kind === 'line' ? '//alpha' : '/*alpha*/');
			await page.evaluate(kind => window.ashStandaloneIntegration.runLineAction(kind === 'line' ? 'editor.action.commentLine' : 'editor.action.blockComment'), kind);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(kind === 'line' ? '//alpha' : '/*alpha*/');
		});

		for (const mode of ['readonly', 'unsupported'] as const) {
			test(`${kind} comment shortcuts leave ${mode} text unchanged`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(mode => window.ashStandaloneIntegration.prepareLineComment({ readOnly: mode === 'readonly', languageId: mode === 'unsupported' ? 'plaintext' : 'typescript' }), mode);
				const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
				await page.keyboard.press(kind === 'line' ? 'ControlOrMeta+/' : 'Alt+Shift+a');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
			});
		}
	}

	test('line comment shortcuts use the configured empty-line policy', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineComment({ value: 'alpha\n\nbeta' }));
		await page.keyboard.press('ControlOrMeta+/');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('// alpha\n\n// beta');
	});

	test('transpose letters keeps a selected primary range while editing a secondary caret', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy());
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.transposeLetters'));
		const after = { value: 'lapha\nbeta\ngamma', selections: ['[3,4 -> 3,2]', '[1,3 -> 1,3]'] };
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(after);
		await page.keyboard.press('ControlOrMeta+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
		await page.keyboard.press('ControlOrMeta+Shift+z');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(after);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('move selected text actions update the document and selection with one undo step', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		for (const [direction, value, selection] of [
			['Left', '023145', '[1,2 -> 1,4]'],
			['Right', '014235', '[1,4 -> 1,6]'],
		] as const) {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareMoveSelectedText());
			await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), `editor.action.moveCarret${direction}Action`);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value, selections: [selection] });
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('012345');
		}
	});

	test('insert final new line action appends an EOL and preserves the editor selection', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareFinalNewLine());
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertFinalNewLine'));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: 'alpha\n', selections: ['[1,2 -> 1,4]'] });
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
	});

	for (const direction of ['Up', 'Down']) {
		test(`copy final lines ${direction} includes the empty last line and restores selections on undo`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy(true));
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), `editor.action.copyLines${direction}Action`);
			const delta = direction === 'Down' ? 1 : 0;
			const copied = { value: 'head\ntail\ntail\n\n', selections: [`[${4 + delta},1 -> ${4 + delta},1]`, `[${2 + delta},3 -> ${2 + delta},1]`] };
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
			await page.keyboard.press('ControlOrMeta+Shift+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});

		test(`copy lines ${direction} retains multiple cursors and separates undo from typing`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCopy());
			await page.keyboard.type('X');
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), `editor.action.copyLines${direction}Action`);
			const copied = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			const delta = direction === 'Down' ? 1 : 0;
			expect(copied).toEqual({ value: 'aXlpha\naXlpha\nbeta\ngXma\ngXma', selections: [`[${4 + delta},3 -> ${4 + delta},3]`, `[${1 + delta},3 -> ${1 + delta},3]`] });
			await page.keyboard.type('!');
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(copied);
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha\nbeta\ngamma');
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			expect(errors).toEqual([]);
		});
	}

	for (const id of ['editor.action.duplicateSelection', 'editor.action.moveLinesDownAction', 'editor.action.sortLinesDescending']) {
		test(`${id} has its own undo step between typing operations`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
			await page.locator('#caller .stanza-editor-input').focus();
			await page.keyboard.type('Z');
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			await page.evaluate(id => window.ashStandaloneIntegration.runLineAction(id), id);
			const edited = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			expect(edited.value).not.toBe(before.value);
			await page.keyboard.type('!');
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(edited);
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test('public range selection replaces the selected text through keyboard input and undo', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const before = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		const selected = await page.evaluate(() => window.ashStandaloneIntegration.selectRange());
		expect(selected).toEqual({ value: 'first\nsecond', version: before.version, selection: '[1,2 -> 2,4]', focused: true });
		await expect(page.locator('#caller .stanza-editor-selection')).toHaveCount(2);
		await expect(input).toBeFocused();
		await page.keyboard.type('X');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('fXond');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('first\nsecond');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().selection)).toBe('[1,2 -> 2,4]');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('standalone editors type and release their models, contributions, registry entries, and DOM', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		await expect(page.locator('#caller .stanza-editor')).toBeVisible();
		await expect(page.locator('#owned .stanza-editor')).toBeVisible();
		const initial = await page.evaluate(() => ({
			events: window.ashStandaloneIntegration.events,
			caller: window.ashStandaloneIntegration.state('caller'),
			owned: window.ashStandaloneIntegration.state('owned'),
		}));
		expect(initial).toEqual({
			events: [
				{ model: 'inmemory://stanza/caller.txt', registered: true, mounted: true, placeholder: true, theme: 'ash-light' },
				{ model: 'inmemory://stanza/owned.txt', registered: true, mounted: true, placeholder: true, theme: 'ash-light' },
			],
			caller: {
				value: 'caller', disposed: false, registered: true, modelRegistered: true,
				mounted: true, placeholder: true, theme: 'ash-light',
			},
			owned: {
				value: 'owned', disposed: false, registered: true, modelRegistered: true,
				mounted: true, placeholder: true, theme: 'ash-light',
			},
		});

		for (const kind of ['caller', 'owned'] as const) {
			const input = page.locator(`#${kind} .stanza-editor-input`);
			await expect(input).toHaveAttribute('aria-label', /.+/u);
			await input.focus();
			await page.keyboard.press('ControlOrMeta+End');
			await page.keyboard.type('!');
			await expect.poll(() => page.evaluate(name => window.ashStandaloneIntegration.state(name).value, kind)).toBe(`${kind}!`);
		}

		await page.evaluate(() => window.ashStandaloneIntegration.releaseCaller());
		await expect(page.locator('#caller .stanza-editor')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).toEqual({
			value: 'changed after editor disposal', disposed: false, registered: false, modelRegistered: true,
			mounted: false, placeholder: false, theme: null,
		});
		await page.evaluate(() => window.ashStandaloneIntegration.releaseOwned());
		await expect(page.locator('#owned .stanza-editor')).toHaveCount(0);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('owned'))).toEqual({
			value: null, disposed: true, registered: false, modelRegistered: false,
			mounted: false, placeholder: false, theme: null,
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('standalone editor switches a live model in place and keeps caller ownership', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		await page.locator('#owned .stanza-editor-input').focus();
		const switched = await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller());
		expect(switched).toEqual({
			ownedModelDisposed: true,
			ownedModelRegistered: false,
			rootRetained: true,
			editorCount: 2,
			currentModelIsCaller: true,
		});
		await expect(page.locator('#owned .stanza-editor')).toHaveCount(1);
		await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.type('!');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.getOwnedValue())).toBe('caller!');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('caller!');

		expect(await page.evaluate(() => window.ashStandaloneIntegration.detachOwned())).toEqual({
			modelIsNull: true,
			value: '',
			rootMounted: true,
			inputCount: 0,
		});
		await page.evaluate(() => window.ashStandaloneIntegration.reattachOwned());
		await expect(page.locator('#owned .stanza-editor-input')).toHaveCount(1);
		await page.locator('#owned .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+End');
		await page.keyboard.type('?');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('caller!?');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.events.length)).toBe(2);
		await page.evaluate(() => window.ashStandaloneIntegration.releaseOwned());
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').disposed)).toBe(false);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('public editor edits preserve complete UTF-16 characters and reject overlapping batches', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.tryOverlappingSurrogateEdits())).toEqual({
			rejected: true,
			value: 'a📚b',
			versionUnchanged: true,
		});
		await expect(page.locator('#caller .view-line')).toContainText('a📚b');
		await expect(page.locator('#owned .view-line')).toContainText('a📚b');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.applySurrogateEdit())).toBe('ab');
		await expect(page.locator('#caller .view-line')).toContainText('ab');
		await expect(page.locator('#owned .view-line')).toContainText('ab');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('same-value reset advances the shared model version and preserves existing snapshots', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
		const result = await page.evaluate(() => window.ashStandaloneIntegration.resetSameValue());
		expect(result).toEqual({
			beforeVersion: result.beforeVersion,
			afterVersion: result.beforeVersion + 1,
			alternativeVersion: result.beforeVersion + 1,
			snapshotValue: 'stable',
			events: [{ version: result.beforeVersion + 1, reason: 'reset', changes: 0 }],
		});
		await expect(page.locator('#caller .view-line')).toContainText('stable');
		await expect(page.locator('#owned .view-line')).toContainText('stable');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('keyboard undo and redo restore multi-cursor selections in a shared model', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
		const input = page.locator('#caller .stanza-editor-input');
		const before = await page.evaluate(() => window.ashStandaloneIntegration.prepareSelectionUndo());
		expect(before.ownedSelections).toEqual(['[2,3 -> 2,3]']);
		await input.focus();
		await expect(input).toBeFocused();
		const focused = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
		expect({
			caller: focused.callerFocused,
			owned: focused.ownedFocused,
			activeInput: focused.activeInput,
		}).toEqual({ caller: true, owned: false, activeInput: 'caller' });
		const edited = await page.evaluate(() => window.ashStandaloneIntegration.applySelectionEdit());
		expect(edited.value).toBe('A\nB');
		expect(edited.callerSelections).toEqual(['[1,2 -> 1,2]', '[2,2 -> 2,2]']);
		expect(edited.ownedSelections).toHaveLength(1);
		expect({
			caller: edited.callerFocused,
			owned: edited.ownedFocused,
			activeInput: edited.activeInput,
		}).toEqual({ caller: true, owned: false, activeInput: 'caller' });

		await page.keyboard.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
		expect({ value: undone.value, version: undone.version, selections: undone.callerSelections }).toEqual({
			value: 'alpha\nbeta',
			version: edited.version + 1,
			selections: ['[1,6 -> 1,1]', '[2,1 -> 2,5]'],
		});
		expect(undone.ownedSelections).toHaveLength(1);
		await expect(page.locator('#caller .view-line')).toContainText(['alpha', 'beta']);
		await expect(page.locator('#owned .view-line')).toContainText(['alpha', 'beta']);

		await page.keyboard.press('ControlOrMeta+Shift+z');
		const redone = await page.evaluate(() => window.ashStandaloneIntegration.readSelectionUndo());
		expect({ value: redone.value, version: redone.version, selections: redone.callerSelections }).toEqual({
			value: 'A\nB',
			version: undone.version + 1,
			selections: edited.callerSelections,
		});
		expect(redone.ownedSelections).toHaveLength(1);
		await expect(page.locator('#caller .view-line')).toContainText(['A', 'B']);
		await expect(page.locator('#owned .view-line')).toContainText(['A', 'B']);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('model word lookup handles empty regular-expression matches before an emoji', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runEmptyWordPattern())).toEqual({ word: 'foo', startColumn: 4, endColumn: 7 });
	});

	for (const kind of ['codeAction', 'rename', 'parameterHints', 'queuedParameterHints'] as const) {
		test(`disposing the editor cancels ${kind} work`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			expect(await page.evaluate(kind => window.ashStandaloneIntegration.runDisposedLanguageRequest(kind), kind)).toEqual(
				kind === 'queuedParameterHints' ? { calls: 0, aborted: false } : { calls: 1, aborted: true },
			);
			expect(errors).toEqual([]);
		});
	}

	suite('parameter hints requests', () => {
		teardown(async function () {
			const { page } = browserTests;

			await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
		});

		const signatures = [
			{ label: 'call(value)', parameters: [{ label: 'value' }], activeParameter: 0 },
			{ label: 'call(other)', parameters: [{ label: 'other' }], activeParameter: 0 },
			{ label: 'call(last)', parameters: [{ label: 'last' }], activeParameter: 0 },
		];

		for (const global of [false, true]) {
			test(`${global ? 'global' : 'editor'} signature commands trigger, switch and close the current result`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
				// The trigger action returns when its provider finishes; dispatch without waiting for it.
				await page.evaluate(global => { void window.ashStandaloneIntegration.runParameterHintCommand('editor.action.triggerParameterHints', global); }, global);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
				await page.evaluate(signatures => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', { signatures, activeSignature: 1 }), signatures);
				const dialog = page.getByRole('dialog', { name: 'Parameter hints' });
				const active = dialog.locator('.stanza-editor-parameter-hints-signature.active');
				await expect(active).toHaveText('call(other)');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintContext())).toEqual({ supported: true, visible: true, multiple: true });
				await page.evaluate(global => window.ashStandaloneIntegration.runParameterHintCommand('showNextParameterHint', global), global);
				await expect(active).toHaveText('call(last)');
				await page.evaluate(global => window.ashStandaloneIntegration.runParameterHintCommand('showPrevParameterHint', global), global);
				await expect(active).toHaveText('call(other)');
				await page.evaluate(global => window.ashStandaloneIntegration.runParameterHintCommand('closeParameterHints', global), global);
				await expect(dialog).toBeHidden();
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintContext())).toEqual({ supported: true, visible: false, multiple: false });
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
				await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
			});
		}

		for (const modifier of ['', 'Alt+']) {
			test(`${modifier || 'unmodified '}arrow keys cycle signatures without changing text, selection or hint nodes`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
				await page.keyboard.press('ControlOrMeta+Shift+Space');
				await page.evaluate(signatures => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', { signatures }), signatures);
				const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
				const dialog = page.getByRole('dialog', { name: 'Parameter hints' });
				const nodes = await dialog.evaluateHandle(element => [...element.children]);
				try {
					const active = dialog.locator('.stanza-editor-parameter-hints-signature.active');
					await expect(dialog).toHaveAttribute('aria-description', /Up and Down/);
					for (const [key, label] of [
						['ArrowDown', 'call(other)'], ['ArrowDown', 'call(last)'], ['ArrowDown', 'call(value)'], ['ArrowUp', 'call(last)'],
					]) {
						await page.keyboard.press(`${modifier}${key}`);
						await expect(active).toHaveText(label!);
						await expect(active).toHaveAttribute('aria-current', 'true');
						await expect(dialog.locator('[aria-current="true"]')).toHaveCount(1);
					}
					expect(await nodes.evaluate(nodes => nodes.every(node => node.isConnected))).toBe(true);
					expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
					expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
					await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
					await page.keyboard.press('Shift+Escape');
					await expect(dialog).toBeHidden();
				} finally {
					await nodes.dispose();
				}
			});
		}

		for (const direction of ['previous', 'next'] as const) {
			test(`non-cycling signatures close beyond the ${direction} boundary`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(true, false));
				await page.keyboard.press('ControlOrMeta+Shift+Space');
				await page.evaluate(({ signatures, direction }) => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', {
					signatures, activeSignature: direction === 'next' ? 2 : 0,
				}), { signatures, direction });
				const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
				await page.keyboard.press(direction === 'next' ? 'ArrowDown' : 'ArrowUp');
				await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual(before);
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintContext())).toEqual({ supported: true, visible: false, multiple: false });
			});
		}

		test('a single signature leaves normal arrow navigation available', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy());
			await page.evaluate(() => window.ashStandaloneIntegration.runParameterHintCommand('showNextParameterHint'));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
			await page.keyboard.press('ArrowUp');
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).not.toEqual(before.selections);
		});

		test('the close signature command cancels a request before hints are visible', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(() => window.ashStandaloneIntegration.runParameterHintCommand('closeParameterHints', true));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.aborted).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
		});

		for (const reason of ['text', 'selection', 'language', 'provider', 'off', 'model', 'contribution', 'dispose', 'blur'] as const) {
			test(`${reason} cancels pending parameter hints and rejects late results`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
				await page.keyboard.press('ControlOrMeta+Shift+Space');
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeParameterHintsState(reason), reason);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.aborted).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
				await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
				if (reason === 'blur') await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
				expect(errors).toEqual([]);
			});
		}

		for (const reason of ['escape', 'selection', 'off', 'blur', 'dispose'] as const) {
			test(`${reason} cancels queued parameter hints before calling a provider`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
				await page.evaluate(reason => window.ashStandaloneIntegration.queueParameterHints(reason), reason);
				// Allow both microtask and timer-based triggers to run before inspecting provider calls.
				await page.evaluate(() => new Promise<void>(resolve => setTimeout(resolve, 20)));
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
				await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
			});
		}

		test('Escape cancels pending parameter hints without closing a newer result', async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
			await page.keyboard.press('Escape');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.aborted).toBe(true);
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(1, 'hints'));
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'error'));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toContainText('call(value): plaintext');
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
			expect(errors).toEqual([]);
		});

		test('first parameter hints are positioned beside the cursor and mark the default signature', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			const dialog = page.getByRole('dialog', { name: 'Parameter hints' });
			await expect(dialog).toBeVisible();
			await expect(dialog.locator('.stanza-editor-parameter-hints-signature.active')).toHaveText('call(value): plaintext');
			await expect(dialog.locator('strong')).toHaveText('value');
			const position = await dialog.evaluate(element => ({ left: parseFloat((element as HTMLElement).style.left), top: parseFloat((element as HTMLElement).style.top), live: element.getAttribute('aria-live') }));
			expect(position.left).toBeGreaterThan(8);
			expect(position.top).toBeGreaterThan(8);
			expect(position.live).toBe('polite');
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		});

		test('only the active signature shows provider documentation in normal and high contrast themes', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', {
				signatures: [
					{ label: 'call(value)', documentation: 'Adds a value', parameters: [{ label: 'value', documentation: 'Value to add' }], activeParameter: 0 },
					{ label: 'call(other)', documentation: 'Uses another argument', parameters: [{ label: 'other', documentation: 'Other argument' }], activeParameter: 0 },
				],
			}));
			const dialog = page.getByRole('dialog', { name: 'Parameter hints' });
			const documentation = dialog.locator('.stanza-editor-parameter-hints-documentation');
			await expect(documentation).toHaveCount(1);
			await expect(documentation).toBeVisible();
			await expect(documentation.locator('div')).toHaveText(['Adds a value', 'Value to add']);

			await page.evaluate(() => window.ashStandaloneIntegration.runParameterHintCommand('showNextParameterHint'));
			await expect(documentation).toHaveCount(1);
			await expect(documentation.locator('div')).toHaveText(['Uses another argument', 'Other argument']);
			await page.evaluate(() => window.ashStandaloneIntegration.setStickyTheme('ash-high-contrast-dark'));
			expect(await documentation.evaluate(element => ({
				border: getComputedStyle(element).borderTopWidth,
				fontSize: getComputedStyle(element).fontSize,
				whiteSpace: getComputedStyle(element).whiteSpace,
				shadow: getComputedStyle(element.closest('.stanza-editor-parameter-hints')!).boxShadow,
			}))).toEqual({ border: '1px', fontSize: '11px', whiteSpace: 'pre-wrap', shadow: 'none' });
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		});

		test('quick edits coalesce into one parameter request at the final cursor', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.evaluate(() => window.ashStandaloneIntegration.queueParameterHints('type'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([{
				text: 'call(a,)', languageId: 'plaintext', position: '(1,8)', context: { kind: 'triggerCharacter', triggerCharacter: ',', isRetrigger: false }, aborted: false,
			}]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
		});

		test('a repeated edit keeps the last active signature while a refresh is pending', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.type('(');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints', {
				signatures: [
					{ label: 'call(value)', parameters: [{ label: 'value' }] },
					{ label: 'call(other)', parameters: [{ label: 'other' }] },
				],
			}));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
			await page.evaluate(() => window.ashStandaloneIntegration.runParameterHintCommand('showNextParameterHint'));

			await page.keyboard.type('a');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(2);
			await page.keyboard.type('b');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(3);
			const requests = await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests());
			expect(requests[1]!.aborted).toBe(true);
			expect(requests[2]!.context).toMatchObject({
				kind: 'contentChange',
				isRetrigger: true,
				activeSignatureHelp: { activeSignature: 1, signatures: [{ label: 'call(value)' }, { label: 'call(other)' }] },
			});
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(2, 'hints'));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
		});

		test('typing refreshes active parameter hints and cancels the previous request', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
			await page.keyboard.type('(');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
			await page.keyboard.type('a');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(2);
			const requests = await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests());
			expect(requests[0]!.aborted).toBe(true);
			expect(requests[1]!).toMatchObject({ position: '(1,7)', context: { kind: 'contentChange' } });
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(1, 'hints'));
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
			await page.keyboard.type('b');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(3);
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(2, 'empty'));
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
		});

		test('background editors sharing the model do not request parameter hints', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareParameterHints();
				window.ashStandaloneIntegration.shareParameterHintsModel();
			});
			await page.keyboard.type('(');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeVisible();
			await expect(page.locator('#owned .stanza-editor-parameter-hints')).toBeHidden();
		});

		test('new parameter requests use the current language', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareParameterHints();
				window.ashStandaloneIntegration.changeParameterHintsState('language');
			});
			await page.keyboard.press('ControlOrMeta+Shift+Space');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.languageId).toBe('typescript');
			await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
			await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toContainText('typescript');
		});

		for (const outcome of ['empty', 'error'] as const) {
			test(`${outcome} parameter result leaves no visible stale hint`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints());
				await page.keyboard.press('ControlOrMeta+Shift+Space');
				await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
				await expect(page.getByRole('dialog', { name: 'Parameter hints' })).toBeVisible();
				await page.keyboard.press('ControlOrMeta+Shift+Space');
				await page.evaluate(outcome => window.ashStandaloneIntegration.finishParameterHintRequest(1, outcome), outcome);
				await expect(page.locator('#caller .stanza-editor-parameter-hints')).toBeHidden();
			});
		}
	});

	suite('rename requests', () => {
		teardown(async function () {
			const { page } = browserTests;

			await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
		});

		for (const phase of ['prepare', 'edit'] as const) {
			for (const reason of ['text', 'selection', 'language', 'provider', 'readonly', 'model', 'contribution', 'dispose', 'blur'] as const) {
				test(`${reason} cancels ${phase} and rejects its late rename`, async function () {
					const { page } = browserTests;

					const errors: string[] = [];
					page.on('pageerror', error => errors.push(error.message));
					await page.goto('/standalone.html');
					await page.waitForFunction(() => window.ashStandaloneIntegration !== undefined);
					await page.evaluate(phase => window.ashStandaloneIntegration.prepareRenameRequests(phase), phase);
					await page.keyboard.press('F2');
					if (phase === 'edit') {
						const input = page.getByRole('textbox', { name: 'New symbol name' });
						await input.fill('result');
						await input.press('Enter');
					}
					await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(1);
					await page.evaluate(reason => window.ashStandaloneIntegration.changeRenameState(reason), reason);
					await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests()[0]!.aborted)).toBe(true);
					await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
					expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(reason === 'text' ? 'changed' : 'value');
					await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
					if (reason === 'blur') await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
					expect(errors).toEqual([]);
				});
			}
		}

		for (const phase of ['prepare', 'edit'] as const) {
			test(`leaving focus and completing ${phase} in the same turn cannot revive the rename`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(phase => window.ashStandaloneIntegration.prepareRenameRequests(phase), phase);
				await page.keyboard.press('F2');
				if (phase === 'edit') {
					const input = page.getByRole('textbox', { name: 'New symbol name' });
					await input.fill('result');
					await input.press('Enter');
				}
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(1);
				await page.evaluate(async () => {
					window.ashStandaloneIntegration.changeRenameState('blur');
					await window.ashStandaloneIntegration.finishRenameRequest(0, 'edit');
				});
				await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
				await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
			});
		}

		test('clicking the input preserves the symbol and repeated Enter submits one undoable rename', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareRenameRequests('edit'));
			const before = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
			await page.keyboard.press('F2');
			const input = page.getByRole('textbox', { name: 'New symbol name' });
			await expect(input).toBeFocused();
			await expect(input).toHaveValue('value');
			await input.click();
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe(before.selection);
			await input.fill('result');
			await input.press('Enter');
			await input.press('Enter');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests())).toEqual([{
				phase: 'edit', languageId: 'plaintext', version: before.version, position: '(1,3)',
				newName: 'result', sameSnapshot: true, aborted: false,
			}]);
			await expect(page.locator('#caller .stanza-editor-rename')).toHaveAttribute('aria-busy', 'true');
			await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
			await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
		});

		for (const phase of ['prepare', 'edit'] as const) {
			test(`Escape cancels ${phase} without allowing its late failure to dismiss a new session`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
				await page.goto('/standalone.html');
				await page.evaluate(phase => window.ashStandaloneIntegration.prepareRenameRequests(phase), phase);
				await page.keyboard.press('F2');
				const input = page.getByRole('textbox', { name: 'New symbol name' });
				if (phase === 'edit') {
					await input.fill('first');
					await input.press('Enter');
				}
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(1);
				await page.keyboard.press('Escape');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests()))[0]!.aborted).toBe(true);
				await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
				await page.keyboard.press('F2');
				if (phase === 'prepare') {
					await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().length)).toBe(2);
					await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(1, 'edit'));
				}
				await input.fill('second');
				await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'error'));
				await expect(input).toBeFocused();
				await expect(input).toHaveValue('second');
				await input.press('Enter');
				if (phase === 'edit') await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(1, 'edit'));
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('second');
				expect(errors).toEqual([]);
			});
		}

		test('an empty name stays editable and announces validation before submission', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareRenameRequests('edit'));
			await page.keyboard.press('F2');
			const input = page.getByRole('textbox', { name: 'New symbol name' });
			await input.fill('   ');
			await input.press('Enter');
			await expect(input).toBeFocused();
			await expect(input).toHaveAttribute('aria-invalid', 'true');
			await expect(page.locator('#caller .stanza-editor-rename-status')).toHaveText('Name cannot be empty');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests())).toEqual([]);
			await input.fill('result');
			await expect(input).not.toHaveAttribute('aria-invalid');
			await input.press('Enter');
			await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
		});

		for (const outcome of ['stale', 'error', 'empty'] as const) {
			test(`${outcome} rename result does not change the document`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareRenameRequests('edit'));
				await page.keyboard.press('F2');
				const input = page.getByRole('textbox', { name: 'New symbol name' });
				await input.fill('result');
				await input.press('Enter');
				await page.evaluate(outcome => window.ashStandaloneIntegration.finishRenameRequest(0, outcome), outcome);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
				await expect(page.locator('#caller .stanza-editor-rename')).not.toHaveAttribute('aria-busy');
				if (outcome === 'empty') {
					await expect(input).toBeHidden();
					expect(errors).toEqual([]);
				} else {
					await expect(input).toBeEditable();
					expect(errors.some(message => message.includes(outcome === 'stale' ? 'requested document version' : 'rename request failed'))).toBe(true);
				}
			});
		}

		test('read-only editors do not start rename preparation', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareRenameRequests('prepare');
				window.ashStandaloneIntegration.changeRenameState('readonly');
			});
			await page.keyboard.press('F2');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests())).toEqual([]);
			await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
		});

		test('new rename preparation uses the current language', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareRenameRequests('prepare');
				window.ashStandaloneIntegration.changeRenameState('language');
			});
			await page.keyboard.press('F2');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readRenameRequests().map(request => request.languageId))).toEqual(['typescript']);
			await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
			const input = page.getByRole('textbox', { name: 'New symbol name' });
			await input.fill('result');
			await input.press('Enter');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
		});
	});

	suite('code action requests', () => {
		teardown(async function () {
			const { page } = browserTests;

			await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
		});

		for (const phase of ['query', 'resolve'] as const) {
			for (const reason of ['text', 'selection', 'language', 'provider', 'readonly', 'model', 'contribution', 'dispose'] as const) {
				test(`${reason} cancels ${phase} and rejects its late edit`, async function () {
					const { page } = browserTests;

					const errors: string[] = [];
					page.on('pageerror', error => errors.push(error.message));
					await page.goto('/standalone.html');
					await page.evaluate(phase => window.ashStandaloneIntegration.prepareCodeActionRequests(phase), phase);
					await page.keyboard.press('ControlOrMeta+.');
					if (phase === 'resolve') {
						await page.getByRole('menuitem', { name: 'Replace value' }).click();
					}
					await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests().length)).toBe(1);
					await page.evaluate(reason => window.ashStandaloneIntegration.changeCodeActionState(reason), reason);
					expect((await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests()))[0]!.aborted).toBe(true);
					await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
					expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(reason === 'text' ? 'changed' : 'value');
					await expect(page.locator('.ash-action-widget')).toBeHidden();
					expect(errors).toEqual([]);
				});
			}
		}

		for (const activation of ['double click', 'Enter', 'Space']) {
			test(`${activation} resolves the original action once and applies one undoable edit`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('resolve'));
				const version = (await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).version;
				await page.keyboard.press('ControlOrMeta+.');
				const action = page.getByRole('menuitem', { name: 'Replace value' });
				if (activation === 'double click') {
					await action.dblclick();
				} else {
					await action.press(activation);
				}
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests())).toEqual([{
					phase: 'resolve',
					languageId: 'plaintext',
					version,
					range: '[1,1 -> 1,6]',
					original: true,
					sameContext: true,
					aborted: false,
				}]);
				await expect(page.locator('.ash-action-widget')).toHaveAttribute('aria-busy', 'true');
				await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
				await expect(page.locator('.ash-action-widget')).toBeHidden();
				await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
			});
		}

		test('Escape cancels a pending query before a menu is displayed', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('query'));
			await page.keyboard.press('ControlOrMeta+.');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests().length)).toBe(1);
			await page.keyboard.press('Escape');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests()))[0]!.aborted).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
			await expect(page.locator('.ash-action-widget')).toBeHidden();
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		});

		test('Escape cancels resolution without allowing its late failure to close a new menu', async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('resolve'));
			await page.keyboard.press('ControlOrMeta+.');
			await page.getByRole('menuitem', { name: 'Replace value' }).click();
			await page.keyboard.press('Escape');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests()))[0]!.aborted).toBe(true);
			await page.keyboard.press('ControlOrMeta+.');
			const action = page.getByRole('menuitem', { name: 'Replace value' });
			await expect(action).toBeFocused();
			await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'error'));
			await expect(action).toBeFocused();
			await action.click();
			await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(1, 'edit'));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
			expect(errors).toEqual([]);
		});

		for (const outcome of ['disabled', 'stale', 'error'] as const) {
			test(`${outcome} resolution does not edit the document`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
				await page.goto('/standalone.html');
				await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionRequests('resolve'));
				await page.keyboard.press('ControlOrMeta+.');
				await page.getByRole('menuitem', { name: 'Replace value' }).click();
				await page.evaluate(outcome => window.ashStandaloneIntegration.finishCodeActionRequest(0, outcome), outcome);
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
				await expect(page.locator('.ash-action-widget[aria-busy="true"]')).toHaveCount(0);
				if (outcome === 'disabled') {
					await expect(page.locator('.ash-action-widget')).toBeHidden();
					expect(errors).toEqual([]);
				} else {
					await expect(page.getByRole('menuitem', { name: 'Replace value' })).toBeVisible();
					expect(errors.some(message => message.includes(outcome === 'stale' ? 'requested document version' : 'code action resolve failed'))).toBe(true);
				}
			});
		}

		test('a new request uses the current model language', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareCodeActionRequests('query');
				window.ashStandaloneIntegration.changeCodeActionState('language');
			});
			await page.keyboard.press('ControlOrMeta+.');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readCodeActionRequests().map(request => request.languageId))).toEqual(['typescript']);
			await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
			await page.getByRole('menuitem', { name: 'Replace value' }).click();
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('result');
		});
	});

	test('code action dismissal restores focus only when its menu owns focus', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions());
		const input = page.locator('#caller .stanza-editor-input');
		const menu = page.locator('.ash-action-widget');
		const action = menu.getByRole('menuitem', { name: 'Example code action' });
		await input.focus();
		await page.keyboard.press('ControlOrMeta+.');
		await expect(action).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		await expect(input).toBeFocused();

		await page.keyboard.press('ControlOrMeta+.');
		await expect(action).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.resetSameValue());
		await expect(menu).toBeHidden();
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('code action keyboard navigation skips disabled actions and applies the focused edit', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions('navigation'));
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('ControlOrMeta+.');
		const menu = page.locator('.ash-action-widget');
		const first = menu.getByRole('menuitem', { name: 'First action', exact: true });
		const last = menu.getByRole('menuitem', { name: 'Last action', exact: true });
		await expect(menu.getByRole('menuitem', { name: 'Unavailable first action (Read only)' })).toBeDisabled();
		await expect(first).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(last).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(first).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(last).toBeFocused();
		await page.keyboard.press('Home');
		await expect(first).toBeFocused();
		await page.keyboard.press('End');
		await expect(last).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(menu).toHaveCount(0);
		await expect(input).toBeFocused();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('last');
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).not.toBe('last');
	});

	test('code action accessibility help returns to the menu and uses the Chinese catalog', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.setActionMenuLanguage('zh-CN');
			window.ashStandaloneIntegration.enableCodeActions('navigation');
		});
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+.');
		const menu = page.getByRole('menu', { name: '操作', exact: true });
		await expect(menu).toHaveAttribute('aria-description', '按 Alt+F1 打开操作菜单的无障碍帮助。');
		await expect(menu.getByRole('menuitem', { name: 'Unavailable first action（Read only）' })).toBeDisabled();
		await page.keyboard.press('Alt+F1');
		const help = page.getByRole('dialog', { name: '操作菜单无障碍帮助' });
		await expect(help).toBeVisible();
		await expect(help).toContainText('用上下方向键切换可用操作');
		await page.keyboard.press('Escape');
		await expect(help).toHaveCount(0);
		await expect(menu.getByRole('menuitem', { name: 'First action', exact: true })).toBeFocused();
		await page.keyboard.press('Escape');
		await expect(menu).toHaveCount(0);
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
	});

	test('code action menu stays inside a narrow viewport and follows light and high contrast themes', async function () {
		const { page } = browserTests;

		await page.setViewportSize({ width: 350, height: 220 });
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions('grouped'));
		const input = page.locator('#caller .stanza-editor-input');
		for (const theme of ['vs', 'vs-dark', 'hc-black', 'hc-light']) {
			await page.evaluate(theme => window.ashStandaloneIntegration.setActionMenuTheme(theme), theme);
			await input.focus();
			await page.keyboard.press('ControlOrMeta+.');
			const action = page.getByRole('menuitem', { name: 'First action', exact: true });
			await expect(action).toBeFocused();
			const style = await action.evaluate(button => {
				const shell = button.closest('.ash-context-view')!;
				const menu = button.closest('.ash-action-widget')!;
				const bounds = shell.getBoundingClientRect();
				return {
					left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom,
					background: getComputedStyle(menu).backgroundColor,
					border: getComputedStyle(menu).borderTopStyle,
					outline: getComputedStyle(button).outlineStyle,
					outlineColor: getComputedStyle(button).outlineColor,
				};
			});
			expect(style.left).toBeGreaterThanOrEqual(0);
			expect(style.top).toBeGreaterThanOrEqual(0);
			expect(style.right).toBeLessThanOrEqual(350);
			expect(style.bottom).toBeLessThanOrEqual(220);
			expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
			expect(style.border).toBe('solid');
			expect(style.outline).toBe('solid');
			expect(style.outlineColor).not.toBe('rgba(0, 0, 0, 0)');
			const tab = page.getByRole('tab', { name: 'All actions', exact: true });
			await expect(tab).toBeVisible();
			await tab.focus();
			await expect(tab).toHaveCSS('outline-style', 'solid');
			const tabBounds = await tab.boundingBox();
			expect(tabBounds!.height).toBeGreaterThan(0);
			expect(tabBounds!.y).toBeGreaterThanOrEqual(0);
			expect(tabBounds!.y + tabBounds!.height).toBeLessThanOrEqual(220);
			await page.keyboard.press('ArrowDown');
			await expect(action).toBeFocused();
			await page.keyboard.press('Escape');
		}
	});

	test('code action outside dismissal leaves focus with the clicked editor', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions());
		const source = page.locator('#caller .stanza-editor-input');
		await source.focus();
		await page.keyboard.press('ControlOrMeta+.');
		await expect(page.locator('.ash-action-widget')).toBeVisible();
		const outside = page.locator('#owned .stanza-editor-input');
		await page.locator('#owned .view-line').first().click();
		await expect(page.locator('.ash-action-widget')).toHaveCount(0);
		await expect(outside).toBeFocused();
	});

	test('shared editors retain line identities through split, undo, and redo', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareLineIdentity());
		expect({
			value: initial.value,
			lineCount: initial.ids.length,
			longLineIndex: initial.longLineIndex,
			longLineEnd: initial.longLineEnd,
		}).toEqual({
			value: 'a\nlonger',
			lineCount: 2,
			longLineIndex: 1,
			longLineEnd: [2, 7],
		});
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		const split = await page.evaluate(() => window.ashStandaloneIntegration.splitLineIdentity());
		expect(split).toEqual({
			value: 'a\n\nlonger',
			version: initial.version + 1,
			ids: [initial.ids[0], split.ids[1], initial.ids[1]],
			longLineIndex: 2,
			longLineEnd: [3, 7],
		});
		expect(split.ids[1]).not.toBe(initial.ids[0]);
		expect(split.ids[1]).not.toBe(initial.ids[1]);
		await expect(page.locator('#caller .view-line')).toHaveCount(3);
		await expect(page.locator('#owned .view-line')).toHaveCount(3);

		await page.keyboard.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readLineIdentity());
		expect(undone).toEqual({ ...initial, version: split.version + 1 });
		await expect(page.locator('#caller .view-line')).toHaveCount(2);
		await expect(page.locator('#owned .view-line')).toHaveCount(2);

		await page.keyboard.press('ControlOrMeta+Shift+z');
		const redone = await page.evaluate(() => window.ashStandaloneIntegration.readLineIdentity());
		expect(redone).toEqual({ ...split, version: undone.version + 1 });
		await expect(page.locator('#caller .view-line')).toHaveCount(3);
		await expect(page.locator('#owned .view-line')).toHaveCount(3);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('large standalone models keep both editors readable within the tokenization budget', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		const state = await page.evaluate(() => window.ashStandaloneIntegration.openLargeModel());
		expect(state).toEqual({
			textUnits: 20_500 * 1_024 + 20_499,
			lineCount: 20_500,
			tooLargeForTokenization: true,
			tooLargeForSynchronization: false,
			attachedEditors: 2,
			firstChunkPrefix: 'x'.repeat(32),
		});
		await expect(page.locator('#caller .view-line').first()).toContainText('x'.repeat(32));
		await expect(page.locator('#owned .view-line').first()).toContainText('x'.repeat(32));
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('completion snippets navigate and undo through the mounted editor', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation('${1:name}(${2:value})$TM_SELECTED_TEXT$0'));
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('Control+Space');
		await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
		await page.keyboard.press('Enter');
		await expect(page.locator('#caller .view-line').first()).toContainText('conname(value)');
		await page.keyboard.type('fn');
		await page.keyboard.press('Tab');
		await page.keyboard.type('arg');
		await page.keyboard.press('Tab');
		await page.keyboard.type(';');
		await expect(page.locator('#caller .view-line').first()).toContainText('confn(arg);');
		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(page.locator('#caller .view-line').first()).toContainText('confn(arg)');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	for (const { placement, snippet, initial, expanded } of [
		{ placement: 'interleaved', snippet: '${1|a,long|} => ${1/(.*)/${1:/upcase}/} $1$0', initial: 'cona => A a', expanded: 'conlong => LONG long' },
		{ placement: 'forward', snippet: '${1/(.*)/${1:/upcase}/} ${1|a,long|}-$1$0', initial: 'conA a-a', expanded: 'conLONG long-long' },
		{ placement: 'nested forward mirror', snippet: '${2:$1-${1|a,long|}} => ${1/(.*)/${1:/upcase}/}$0', initial: 'cona-a => A', expanded: 'conlong-long => LONG' },
	]) {
		test(`snippet choices keep ${placement} transforms and mirrors together through undo and redo`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			await page.evaluate(snippet => window.ashStandaloneIntegration.enableCompletionNavigation(snippet), snippet);
			await page.locator('#caller .stanza-editor-input').focus();
			await page.keyboard.press('Control+Space');
			await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
			await page.keyboard.press('Enter');
			const line = page.locator('#caller .view-line').first();
			await expect(line).toContainText(initial);
			const version = await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion());
			await page.keyboard.press('Alt+ArrowDown');
			await expect(line).toContainText(expanded);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version + 1);
			await page.keyboard.press('ControlOrMeta+z');
			await expect(line).toContainText(initial);
			await page.keyboard.press('Alt+ArrowDown');
			await expect(line).toContainText(expanded);
			await page.keyboard.press('ControlOrMeta+z');
			await expect(line).toContainText(initial);
			await page.keyboard.press('ControlOrMeta+Shift+z');
			await expect(line).toContainText(expanded);
			await page.keyboard.press('Alt+ArrowUp');
			await expect(line).toContainText(initial);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			expect(errors).toEqual([]);
		});
	}

	test('completion arrow keys select a suggestion before editor navigation', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation());
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('Control+Space');
		const options = page.locator('#caller .stanza-editor-completion-option');
		await expect(options).toHaveCount(2);
		for (const option of await options.all()) expect((await option.boundingBox())!.height).toBe(22);
		await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 4 });

		await page.keyboard.press('ArrowDown');
		await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
		const optionId = await options.nth(1).getAttribute('id');
		expect(optionId).toBeTruthy();
		await expect(input).toHaveAttribute('aria-activedescendant', optionId!);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual({ lineNumber: 1, column: 4 });
		await page.keyboard.press('Enter');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('conconsole');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ fontSize: 24, lineHeight: 32 });
			window.ashStandaloneIntegration.enableCompletionNavigation();
		});
		await input.focus();
		await page.keyboard.press('Control+Space');
		await expect(options).toHaveCount(2);
		for (const option of await options.all()) expect((await option.boundingBox())!.height).toBeGreaterThanOrEqual(32);
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('keyboard selection, deletion, undo, and typing share one edit path', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareKeyboardEditing());
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('Shift+ArrowDown');
		const selected = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: selected.value, version: selected.version, selection: selected.selection }).toEqual({
			value: 'first\nsecond',
			version: initial.version,
			selection: '[1,3 -> 2,3]',
		});

		await page.keyboard.press('Backspace');
		const deleted = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: deleted.value, version: deleted.version, selection: deleted.selection }).toEqual({
			value: 'ficond',
			version: initial.version + 1,
			selection: '[1,3 -> 1,3]',
		});
		await page.keyboard.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: undone.value, version: undone.version, selection: undone.selection }).toEqual({
			value: 'first\nsecond',
			version: deleted.version + 1,
			selection: '[1,3 -> 2,3]',
		});

		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowRight');
		await page.keyboard.type('X');
		const typed = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
		expect({ value: typed.value, version: typed.version, selection: typed.selection, focused: typed.focused }).toEqual({
			value: 'firXst\nsecond',
			version: undone.version + 1,
			selection: '[1,5 -> 1,5]',
			focused: true,
		});
		await expect(page.locator('#caller .view-line').first()).toContainText('firXst');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('double-clicking editor text selects the whole word', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.preparePointerSelection());
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
		await expect(page.locator('#caller .view-line > span')).toHaveText(['alpha beta', 'second line']);
		const character = await page.evaluate(() => {
			const spans = [...document.querySelectorAll('#caller .view-line > span > span')];
			const box = spans[0]?.getBoundingClientRect();
			return { text: spans.map(span => span.textContent).join(''), box: box && { x: box.x, y: box.y, width: box.width, height: box.height } };
		});
		expect(character.text.startsWith('alpha beta')).toBe(true);
		expect(character.box).toBeTruthy();
		await page.mouse.dblclick(character.box!.x + character.box!.width / 4, character.box!.y + character.box!.height / 2);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection())).toEqual({
			value: 'alpha beta\nsecond line',
			version: before.version,
			selection: '[1,1 -> 1,6]',
			ownedSelection: before.ownedSelection,
			focused: true,
			mouseUpEvents: 2,
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('pointer drag extends one editor selection and stops on release', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.preparePointerSelection());
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
		await expect(page.locator('#caller .view-line > span')).toHaveText(['alpha beta', 'second line']);
		const lines = await page.evaluate(() => [...document.querySelectorAll('#caller .view-line > span > span')].map((span, index) => {
			const box = span.getBoundingClientRect();
			const range = document.createRange();
			range.setStart(span.firstChild!, index === 0 ? 3 : 8);
			range.collapse(true);
			return { text: span.textContent, x: range.getBoundingClientRect().left - 0.25, y: box.y + box.height / 2 };
		}));
		expect(lines.map(line => line.text)).toEqual(['alpha beta', 'second line']);
		await page.mouse.move(lines[0]!.x, lines[0]!.y);
		await page.mouse.down();
		await page.mouse.move(lines[1]!.x, lines[1]!.y, { steps: 5 });
		await page.mouse.up();
		const selected = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
		expect(selected.selection).toBe('[1,4 -> 2,9]');
		expect({ value: selected.value, version: selected.version, ownedSelection: selected.ownedSelection, focused: selected.focused, mouseUpEvents: selected.mouseUpEvents }).toEqual({
			value: before.value,
			version: before.version,
			ownedSelection: before.ownedSelection,
			focused: true,
			mouseUpEvents: 1,
		});
		await page.mouse.move(lines[0]!.x, lines[0]!.y);
		const released = await page.evaluate(() => window.ashStandaloneIntegration.readPointerSelection());
		expect({ selection: released.selection, mouseUpEvents: released.mouseUpEvents }).toEqual({ selection: selected.selection, mouseUpEvents: 1 });
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('Alt-click toggles editor-local cursors and one typing transaction edits both lines', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.switchOwnedToCaller())).currentModelIsCaller).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareMultiCursor());
		await expect(page.locator('#caller .view-line > span')).toHaveText(['abcd', 'efgh']);
		const lines = await page.evaluate(() => [...document.querySelectorAll('#caller .view-line > span > span')].map(span => {
			const box = span.getBoundingClientRect();
			return { text: span.textContent, x: box.x, y: box.y, width: box.width, height: box.height };
		}));
		expect(lines.map(line => line.text)).toEqual(['abcd', 'efgh']);
		const first = { x: lines[0]!.x + lines[0]!.width * 0.4, y: lines[0]!.y + lines[0]!.height / 2 };
		const second = { x: lines[1]!.x + lines[1]!.width * 0.4, y: lines[1]!.y + lines[1]!.height / 2 };
		await page.mouse.click(first.x, first.y);
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
		await page.keyboard.down('Alt');
		await page.mouse.click(second.x, second.y);
		await page.keyboard.up('Alt');
		const added = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
		expect(added.selections).toHaveLength(2);
		expect(added.selections.map(selection => Number(selection.match(/^\[(\d+),/u)?.[1])).sort()).toEqual([1, 2]);
		expect({ value: added.value, version: added.version, ownedSelections: added.ownedSelections }).toEqual({
			value: initial.value,
			version: initial.version,
			ownedSelections: initial.ownedSelections,
		});

		await page.keyboard.down('Alt');
		await page.mouse.click(second.x, second.y);
		await page.keyboard.up('Alt');
		const removed = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
		expect(removed.selections).toHaveLength(1);
		expect(removed.selections[0]).toMatch(/^\[1,/u);
		await page.keyboard.down('Alt');
		await page.mouse.click(second.x, second.y);
		await page.keyboard.up('Alt');
		await page.keyboard.type('X');
		const typed = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
		expect(typed.value.split('\n').map(line => (line.match(/X/gu) ?? []).length)).toEqual([1, 1]);
		expect(typed.version).toBe(initial.version + 1);
		expect(typed.ownedSelections).toHaveLength(1);
		await page.keyboard.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor());
		expect(undone.value).toBe('abcd\nefgh');
		expect(undone.version).toBe(typed.version + 1);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('soft wrapping keeps layout, model coordinates and pointer selection in sync after resize and edit', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareWrappedLayout());
		expect(initial.modelLineCount).toBe(1);
		expect(initial.contentHeight).toBeGreaterThan(80);
		const rows = page.locator('#caller .view-line');
		const initialRows = await rows.count();
		expect(initialRows).toBeGreaterThan(1);
		const firstText = (await rows.first().textContent()) ?? '';
		const second = await rows.nth(1).boundingBox();
		expect(second).not.toBeNull();
		await page.mouse.click(second!.x + 8, second!.y + second!.height / 2);
		const selected = await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition());
		expect(selected?.lineNumber).toBe(1);
		expect(selected?.column).toBeGreaterThan(firstText.length);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readWrappedLayout())).toEqual(initial);

		const wider = await page.evaluate(() => window.ashStandaloneIntegration.resizeWrappedLayout(320));
		expect({ value: wider.value, version: wider.version, modelLineCount: wider.modelLineCount }).toEqual({
			value: initial.value,
			version: initial.version,
			modelLineCount: 1,
		});
		expect(wider.contentHeight).toBeLessThan(initial.contentHeight);
		await expect.poll(() => rows.count()).toBeLessThan(initialRows);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerPosition())).toEqual(selected);

		const short = await page.evaluate(() => window.ashStandaloneIntegration.editWrappedText('short'));
		expect(short).toEqual({ value: 'short', version: initial.version + 1, modelLineCount: 1, contentHeight: 80 });
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText('short');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('proportional-font soft wrapping keeps a word together at the available width', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		const state = await page.evaluate(() => window.ashStandaloneIntegration.prepareProportionalWrap());
		expect({ value: state.value, modelLineCount: state.modelLineCount }).toEqual({ value: 'abc defgh', modelLineCount: 1 });
		const rows = page.locator('#caller .view-line');
		await expect(rows).toHaveCount(2);
		expect(await rows.allTextContents()).toEqual(['abc ', 'defgh']);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('scrolling keeps overlapping visible rows attached and releases rows that leave the viewport', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareVisibleRows());
		expect(initial.lineCount).toBe(80);
		await expect(page.locator('#caller .view-line > span')).toHaveText(['line-00', 'line-01', 'line-02', 'line-03', 'line-04']);
		await expect(page.locator('#caller .stanza-editor-row-layer.view-overlays > div')).toHaveCount(5);
		const result = await page.evaluate(async () => {
			const layers = [...document.querySelectorAll<HTMLElement>('#caller .view-lines, #caller .stanza-editor-row-layer.view-overlays')];
			const tracked = layers.map(layer => {
				const before = new Map<number, HTMLElement>();
				for (const child of layer.children) {
					const row = child as HTMLElement;
					before.set(Number(row.dataset.lineIndex), row);
				}
				const removed = new Set<Node>();
				const observer = new MutationObserver(records => {
					for (const record of records) {
						for (const node of record.removedNodes) {
							removed.add(node);
						}
					}
				});
				observer.observe(layer, { childList: true });
				return { layer, before, removed, observer };
			});
			let scrollTop = 0;
			try {
				scrollTop = window.ashStandaloneIntegration.scrollVisibleRows(60);
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
			} finally {
				for (const entry of tracked) {
					entry.observer.disconnect();
				}
			}
			const snapshots = tracked.map(({ layer, before, removed }) => {
				const after = new Map<number, HTMLElement>();
				for (const child of layer.children) {
					const row = child as HTMLElement;
					after.set(Number(row.dataset.lineIndex), row);
				}
				const overlap = [...before.keys()].filter(index => after.has(index));
				return {
					kind: layer.classList.contains('view-lines') ? 'text' : 'overlay',
					beforeCount: before.size,
					afterCount: after.size,
					firstBefore: Math.min(...before.keys()),
					firstAfter: Math.min(...after.keys()),
					firstText: after.values().next().value?.textContent ?? '',
					overlap: overlap.length,
					stable: overlap.every(index => before.get(index) === after.get(index)),
					removedOverlap: overlap.filter(index => removed.has(before.get(index)!)).length,
					staleDetached: [...before].filter(([index]) => !after.has(index)).every(([, row]) => !row.isConnected),
				};
			});
			return { scrollTop, snapshots };
		});
		expect(result.scrollTop).toBe(60);
		expect(result.snapshots.length).toBeGreaterThanOrEqual(2);
		for (const layer of result.snapshots) {
			expect(layer.beforeCount).toBeGreaterThan(0);
			expect(layer.afterCount).toBeLessThan(20);
			expect(layer.firstAfter).toBeGreaterThan(layer.firstBefore);
			expect(layer.overlap).toBeGreaterThan(0);
			expect(layer.stable).toBe(true);
			expect(layer.removedOverlap).toBe(0);
			expect(layer.staleDetached).toBe(true);
		}
		const textLayer = result.snapshots.find(layer => layer.kind === 'text');
		if (!textLayer) throw new Error('Visible text layer is unavailable');
		expect(textLayer.firstText).toContain(`line-${String(textLayer.firstAfter).padStart(2, '0')}`);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version);
		const updated = await page.evaluate(async lineIndex => {
			const selector = `#caller .view-line[data-line-index="${lineIndex}"]`;
			const row = document.querySelector<HTMLElement>(selector);
			const layer = document.querySelector<HTMLElement>('#caller .view-lines');
			if (!row || !layer) throw new Error('Visible text row is unavailable');
			let removed = false;
			const observer = new MutationObserver(records => {
				for (const record of records) {
					for (const node of record.removedNodes) {
						if (node === row) removed = true;
					}
				}
			});
			observer.observe(layer, { childList: true });
			try {
				const value = window.ashStandaloneIntegration.editVisibleRow(lineIndex);
				await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
				return { value, sameNode: document.querySelector(selector) === row, connected: row.isConnected, removed, text: row.textContent };
			} finally {
				observer.disconnect();
			}
		}, textLayer.firstAfter);
		expect(updated).toEqual({
			value: `changed-${textLayer.firstAfter}`,
			sameNode: true,
			connected: true,
			removed: false,
			text: `changed-${textLayer.firstAfter}`,
		});
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version + 1);
		const released = await page.evaluate(() => {
			const rows = [...document.querySelectorAll('#caller .view-line')];
			window.ashStandaloneIntegration.dispose();
			return { detached: rows.every(row => !row.isConnected), roots: document.querySelectorAll('#caller .view-lines').length };
		});
		expect(released).toEqual({ detached: true, roots: 0 });
		expect(errors).toEqual([]);
	});

	test('wrapped cursor and gutter markers stay on their model lines through navigation and editing', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.stack ?? error.message));
		await page.goto('/standalone.html');
		const initial = await page.evaluate(() => window.ashStandaloneIntegration.prepareCursorGutter());
		expect(initial.modelLineCount).toBe(2);
		await page.locator('#caller .stanza-editor-input').focus();
		await expect(page.locator('#caller .view-line[data-logical-line-index="1"] > span')).toHaveText('next');
		await expect(page.locator('#caller .ash-gutter-probe')).toHaveCount(1);
		const readGeometry = async () => page.evaluate(() => {
			const firstRows = [...document.querySelectorAll<HTMLElement>('#caller .view-line[data-logical-line-index="0"]')];
			const secondRow = document.querySelector<HTMLElement>('#caller .view-line[data-logical-line-index="1"]');
			const caret = document.querySelector<HTMLElement>('#caller .stanza-editor-caret.primary');
			const glyphs = [...document.querySelectorAll<HTMLElement>('#caller .ash-gutter-probe')];
			const numberRows = [...document.querySelectorAll<HTMLElement>('#caller .margin-view-overlays .view-overlay-line')];
			if (!firstRows.length || !secondRow || !caret) {
				throw new Error(`Cursor and gutter rows are unavailable: first=${firstRows.length}, second=${Boolean(secondRow)}, caret=${Boolean(caret)}`);
			}
			return {
				wrappedRows: firstRows.length,
				firstTop: firstRows[0]!.getBoundingClientRect().top,
				lastTop: firstRows.at(-1)!.getBoundingClientRect().top,
				secondTop: secondRow.getBoundingClientRect().top,
				caretTop: caret.getBoundingClientRect().top,
				glyphTops: glyphs.map(glyph => glyph.getBoundingClientRect().top),
				numbers: numberRows.map(row => row.querySelector('.line-numbers')?.textContent ?? ''),
			};
		});
		const wrapped = await readGeometry();
		expect(wrapped.wrappedRows).toBeGreaterThan(1);
		expect(wrapped.numbers[0]).toBe('1');
		expect(wrapped.numbers.slice(1, wrapped.wrappedRows)).toEqual(Array(wrapped.wrappedRows - 1).fill(''));
		expect(wrapped.numbers[wrapped.wrappedRows]).toBe('1');
		expect(wrapped.glyphTops).toEqual([wrapped.firstTop]);
		expect(wrapped.caretTop).toBe(wrapped.lastTop);

		await page.evaluate(() => window.ashStandaloneIntegration.moveGutterCaret(2, 1));
		await expect.poll(async () => {
			const geometry = await readGeometry();
			return geometry.caretTop - geometry.secondTop;
		}).toBe(0);
		const moved = await readGeometry();
		expect(moved.caretTop).toBe(moved.secondTop);
		expect(moved.glyphTops).toEqual([moved.firstTop]);
		expect(moved.numbers[0]).toBe('1');
		expect(moved.numbers[moved.wrappedRows]).toBe('2');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(initial.version);

		const editedVersion = await page.evaluate(() => window.ashStandaloneIntegration.shortenGutterLine());
		expect(editedVersion).toBe(initial.version + 1);
		await expect(page.locator('#caller .view-line > span')).toHaveText(['short', 'next']);
		await expect.poll(async () => {
			const geometry = await readGeometry();
			return geometry.caretTop - geometry.secondTop;
		}).toBe(0);
		const shortened = await readGeometry();
		expect(shortened.secondTop).toBeLessThan(moved.secondTop);
		expect(shortened.caretTop).toBe(shortened.secondTop);
		expect(shortened.glyphTops).toEqual([shortened.firstTop]);
		expect(shortened.numbers[0]).toBe('1');
		expect(shortened.numbers[shortened.wrappedRows]).toBe('2');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		await expect(page.locator('#caller .ash-gutter-probe')).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	for (const unit of ['pixels', 'lines'] as const) {
		test(`standalone view zones collapse and expand in ${unit} without changing text or decoration anchors`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			const initial = await page.evaluate(value => window.ashStandaloneIntegration.prepareViewZone(value), unit);
			expect(initial.computedHeights).toEqual([0]);
			const zone = page.locator('#caller .ash-zone-probe');
			const margin = page.locator('#caller .ash-zone-margin-probe');
			const block = page.locator('#caller .ash-zone-block-probe');
			const caret = page.locator('#caller .stanza-editor-caret.primary');
			await page.locator('#caller .stanza-editor-input').focus();
			await expect(zone).toHaveCount(1);
			await expect(zone).toHaveAttribute('data-computed-height', '0');
			await expect(zone).toBeHidden();
			await expect(margin).toBeHidden();
			const originalBlock = await block.boundingBox();
			expect(originalBlock).not.toBeNull();
			const originalCaret = await caret.boundingBox();
			expect(originalCaret).not.toBeNull();
			const node = await zone.elementHandle();
			const height = unit === 'pixels' ? 40 : 2;
			const expanded = await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 1), height);
			expect(expanded).toEqual({
				version: initial.version,
				lineTop: initial.lineTop + 40,
				contentHeight: initial.contentHeight + 40,
				computedHeights: [0, 40],
			});
			await expect(zone).toBeVisible();
			await expect(zone).toHaveCSS('height', '40px');
			await expect(zone).toHaveAttribute('data-computed-height', '40');
			await expect(zone).toHaveAttribute('data-top', '20');
			await expect(margin).toHaveCSS('height', '40px');
			await expect.poll(async () => (await block.boundingBox())?.height).toBe(originalBlock!.height + 40);
			await expect.poll(async () => (await caret.boundingBox())?.y).toBe(originalCaret!.y + 40);
			expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-zone-probe'))).toBe(true);

			const moved = await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 2), height);
			expect(moved.lineTop).toBe(initial.lineTop);
			await expect.poll(async () => (await caret.boundingBox())?.y).toBe(originalCaret!.y);
			await expect.poll(async () => (await block.boundingBox())?.y).toBe(originalBlock!.y);
			const collapsed = await page.evaluate(() => window.ashStandaloneIntegration.resizeViewZone(0, 1));
			expect(collapsed).toEqual({ ...initial, computedHeights: [0, 40, 40, 0] });
			await expect.poll(async () => (await block.boundingBox())?.height).toBe(originalBlock!.height);
			await expect(zone).toBeHidden();
			await expect(margin).toBeHidden();
			await page.evaluate(value => window.ashStandaloneIntegration.resizeViewZone(value, 1), height);
			await expect(zone).toBeVisible();
			await page.evaluate(() => window.ashStandaloneIntegration.removeViewZone());
			await expect(zone).toHaveCount(0);
			await expect(margin).toHaveCount(0);
			await expect.poll(async () => (await block.boundingBox())?.y).toBe(originalBlock!.y);
			expect(await node!.evaluate(element => element.isConnected)).toBe(false);
			await node!.dispose();
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			expect(errors).toEqual([]);
		});
	}

	test('public editor contracts honor initial wrapping, animated scrolling, content events, and detachment', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.checkContracts())).toEqual({
			wrapping: 'on', wrapped: true, animated: true, settled: true, top: 600, interrupted: true, detached: true, eventTexts: ['X'],
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});


	test('standalone marker decorations appear and clear through the shared marker service', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.setTestMarkers(true));
		await expect(page.locator('#caller .squiggly-error')).toHaveCount(1);
		await page.evaluate(() => window.ashStandaloneIntegration.setTestMarkers(false));
		await expect(page.locator('#caller .squiggly-error')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone marker API preserves other models when one owner updates a model', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const result = await page.evaluate(() => window.ashStandaloneIntegration.exerciseMarkerApi());
		expect(result).toEqual({
			first: ['caller'],
			second: ['owned'],
			afterClear: ['owned'],
			events: [
				['inmemory://stanza/caller.txt'],
				['inmemory://stanza/owned.txt'],
				['inmemory://stanza/caller.txt'],
				['inmemory://stanza/owned.txt'],
			],
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone marker boundary rejects an invalid batch without replacing current diagnostics', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const result = await page.evaluate(() => window.ashStandaloneIntegration.exerciseMarkerBoundary());
		expect(result.errors).toEqual([
			'Marker positions must be positive integers',
			'Marker positions must be positive integers',
			'Marker positions must be positive integers',
			'Marker message must not be empty',
			'Unknown marker severity',
			'Invalid marker code',
		]);
		expect(result.messages).toEqual(['retained']);
		expect(result.changed).toBe(0);
		expect(result.version).toBeGreaterThan(0);
		expect(result.code).toBe('0');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('generic code action and organize imports commands apply their matching action once', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		for (const [command, args, text] of [
			['editor.action.codeAction', { kind: 'refactor.extract', apply: 'ifSingle' }, 'refactor.extract beta alpha'],
			['editor.action.organizeImports', undefined, 'source.organizeImports beta alpha'],
		] as const) {
			await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
			await page.evaluate(([command, args]) => window.ashStandaloneIntegration.runFoldingCommand(command, args), [command, args] as const);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe(text);
			await expect(page.locator('.ash-action-widget')).toHaveCount(0);
			await page.keyboard.press('ControlOrMeta+z');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('alpha beta alpha');
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	for (const outcome of ['accept', 'cancel'] as const) {
		test(`rename input previews its edit before ${outcome}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			if (outcome === 'cancel') {
				await page.evaluate(() => window.ashStandaloneIntegration.setActionMenuLanguage('zh-CN'));
			}
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareEditorContextMenu(true);
				window.ashStandaloneIntegration.prepareCodeActionPreview();
			});
			await page.locator('#action-preview-editor .stanza-editor-input').press('F2');
			const name = page.getByRole('textbox', { name: outcome === 'cancel' ? '新的符号名称' : 'New symbol name', exact: true });
			await name.fill('renamed');
			await name.press('ControlOrMeta+Enter');
			const apply = page.locator('#action-preview-pane').getByRole('button', { name: outcome === 'cancel' ? '应用所选修改' : 'Apply selected', exact: true });
			await expect(apply).toBeEnabled();
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
			if (outcome === 'accept') {
				await apply.click();
			} else {
				await page.locator('#action-preview-pane').getByRole('button', { name: '取消', exact: true }).click();
			}
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe(outcome === 'accept' ? 'renamed' : 'value');
			await expect(name).toBeHidden();
			expect(errors).toEqual([]);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test('reference preview and automatic code action labels use the Chinese catalog', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.setActionMenuLanguage('zh-CN');
			window.ashStandaloneIntegration.prepareEditorContextMenu(true);
		});
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await input.press('Shift+F10');
		const peek = page.getByRole('menuitem', { name: 'Peek', exact: true });
		await peek.focus();
		await peek.press('ArrowRight');
		await page.getByRole('menuitem', { name: 'Peek References', exact: true }).click();
		await expect(page.getByRole('listbox', { name: '引用', exact: true })).toBeVisible();
		await expect(page.getByRole('textbox', { name: '引用预览', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		// Product language changes recreate the editor; this fixture creates that editor after loading the catalog.
		await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionPreview());
		await expect(page.locator('#action-preview-editor').getByRole('button', { name: '显示代码操作', exact: true })).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('definition modifier gesture highlights, cancels and follows the configured click modifier', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		for (const [multiCursorModifier, trigger] of [['alt', 'ControlOrMeta'], ['ctrlCmd', 'Alt']] as const) {
			await page.evaluate(modifier => {
				window.ashStandaloneIntegration.prepareEditorContextMenu(true);
				window.ashStandaloneIntegration.updateContributionOptions({ multiCursorModifier: modifier });
			}, multiCursorModifier);
			const point = await page.evaluate(() => window.ashStandaloneIntegration.languageHoverPoint());
			await page.mouse.move(point.x, point.y);
			await page.keyboard.down(trigger);
			await expect(page.locator('#caller .stanza-editor-definition-link')).toHaveCount(1);
			await page.keyboard.up(trigger);
			await expect(page.locator('#caller .stanza-editor-definition-link')).toHaveCount(0);
			await page.keyboard.down(trigger);
			await page.mouse.click(point.x, point.y);
			await page.keyboard.up(trigger);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().selection)).toBe('[1,7 -> 1,11]');
		}
		expect(errors).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('automatic code action lightbulb opens the shared menu and follows configuration and themes', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareEditorContextMenu(true));
		const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
		const lightbulb = page.getByRole('button', { name: 'Show code actions', exact: true });
		await expect(lightbulb).toBeVisible();
		for (const theme of ['ash-light', 'ash-dark', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashStandaloneIntegration.setStickyTheme(theme), theme);
			await expect(lightbulb).toBeVisible();
			expect(await lightbulb.evaluate(element => getComputedStyle(element).color)).not.toBe('rgba(0, 0, 0, 0)');
		}
		await lightbulb.click();
		await expect(page.locator('.ash-action-widget').getByRole('menuitem')).toHaveCount(4);
		await page.getByRole('menuitem', { name: 'Apply quickfix', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing().value)).toBe('quickfix beta alpha');
		await expect(input).toBeFocused();
		await page.evaluate(mode => window.ashStandaloneIntegration.updateContributionOptions({ lightbulb: { enabled: mode } }), ShowLightbulbIconMode.Off);
		await expect(lightbulb).not.toBeVisible();
		expect(errors).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('reference Peek cycles results, switches focus and continues navigation after opening a result', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareReferencePreview());
		await page.locator('#caller > .stanza-editor .stanza-editor-input').first().focus();
		await page.keyboard.press('Shift+F12');
		const results = page.locator('.stanza-editor-language-locations button');
		await expect(results.first()).toBeFocused();
		await page.keyboard.press('F4');
		await expect(results.nth(1)).toBeFocused();
		await page.keyboard.press('F6');
		await expect(page.locator('.stanza-editor-language-preview .stanza-editor-input')).toBeFocused();
		await page.keyboard.press('F6');
		await expect(results.nth(1)).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(results).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor().selections)).toEqual(['[2,1 -> 2,6]']);
		await page.keyboard.press('F12');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readMultiCursor().selections)).toEqual(['[1,1 -> 1,6]']);
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('reference Peek embeds a read-only editor that follows parent configuration and releases on Escape', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareReferencePreview());
		const input = page.locator('#caller > .stanza-editor .stanza-editor-input').first();
		await input.focus();
		await page.keyboard.press('Shift+F12');
		const preview = page.locator('.stanza-editor-language-preview .stanza-editor');
		await expect(preview).toBeVisible();
		await expect(preview.locator('.stanza-editor-line-text').first()).toContainText('alpha beta');
		await page.evaluate(() => window.ashStandaloneIntegration.setParentFontSize());
		await expect(preview.locator('.stanza-editor-line-text').first()).toHaveCSS('font-size', '18px');
		await preview.locator('.stanza-editor-input').focus();
		await page.keyboard.type('X');
		await expect(preview.locator('.stanza-editor-line-text').first()).toContainText('alpha beta');
		await page.keyboard.press('Escape');
		await expect(preview).toHaveCount(0);
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('minimap repaints token colors when the registry palette changes', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.setMinimapColor('#ff0000'));
		await expect.poll(async () => {
			const [red, green, blue] = await page.evaluate(() => window.ashStandaloneIntegration.readMinimapPixel());
			return red > green && red > blue && green === blue;
		}).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.setMinimapColor('#0000ff'));
		await expect.poll(async () => {
			const [red, green, blue] = await page.evaluate(() => window.ashStandaloneIntegration.readMinimapPixel());
			return blue > red && blue > green && red === green;
		}).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standalone view zones stay after the wrapped fold header while folded and scrolled', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const version = await page.evaluate(() => window.ashStandaloneIntegration.prepareFoldedViewZone(true));
		const zone = page.locator('#caller .ash-folded-zone-probe');
		const margin = page.locator('#caller .ash-folded-zone-margin-probe');
		await expect(zone).toHaveCSS('top', '80px');
		const node = await zone.elementHandle();
		await page.locator('#caller .ash-icon-folding-expanded').first().click();
		await expect(page.locator('#caller .ash-icon-folding-collapsed').first()).toBeVisible();
		await expect(zone).toHaveCSS('top', '60px');
		await expect(zone).toHaveAttribute('data-computed-height', '40');
		await expect(zone).toHaveAttribute('data-top', '60');
		await expect(margin).toHaveCSS('top', '60px');
		await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(40));
		await expect(zone).toBeVisible();
		await expect(zone).toHaveAttribute('data-top', '20');
		await expect.poll(async () => {
			const bounds = await zone.boundingBox();
			const root = await page.locator('#caller .stanza-editor').boundingBox();
			return bounds && root ? Math.round(bounds.y - root.y) : null;
		}).toBe(20);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
		await page.locator('#caller .ash-icon-folding-collapsed').first().click();
		await expect(zone).toHaveCSS('top', '80px');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version);
		expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-folded-zone-probe'))).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(await node!.evaluate(element => element.isConnected)).toBe(false);
		await node!.dispose();
		expect(errors).toEqual([]);
	});


	test('folding hides view zones and restores their layout callbacks after scrolling and unfolding', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const version = await page.evaluate(() => window.ashStandaloneIntegration.prepareFoldedViewZone(false));
		const zone = page.locator('#caller .ash-folded-zone-probe');
		const margin = page.locator('#caller .ash-folded-zone-margin-probe');
		await expect(zone).toHaveAttribute('data-computed-height', '40');
		await expect(zone).toHaveAttribute('data-top', '80');
		const node = await zone.elementHandle();
		await page.locator('#caller .ash-icon-folding-expanded').first().click();
		await expect(zone).toBeHidden();
		await expect(margin).toBeHidden();
		await expect(zone).toHaveAttribute('data-computed-height', '0');
		await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(40));
		await expect(zone).toBeHidden();
		await expect.poll(() => zone.getAttribute('data-top').then(Number)).toBeLessThan(0);
		await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
		await page.locator('#caller .ash-icon-folding-collapsed').first().click();
		await expect(zone).toBeVisible();
		await expect(margin).toBeVisible();
		await expect(zone).toHaveAttribute('data-computed-height', '40');
		await expect(zone).toHaveAttribute('data-top', '80');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version);
		expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-folded-zone-probe'))).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(await node!.evaluate(element => element.isConnected)).toBe(false);
		await node!.dispose();
		expect(errors).toEqual([]);
	});


	for (const showInHiddenAreas of [false, true]) {
		test(`decorations and view zones retain geometry through rewrapping, folding and scrolling with hidden zones ${showInHiddenAreas}`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			const version = await page.evaluate(value => window.ashStandaloneIntegration.prepareFoldedViewZone(value), showInHiddenAreas);
			const zone = page.locator('#caller .ash-folded-zone-probe');
			const margin = page.locator('#caller .ash-folded-zone-margin-probe');
			const block = page.locator('#caller .ash-folded-block-probe');
			const inline = page.locator('#caller .ash-folded-inline-probe');
			const hidden = page.locator('#caller .ash-folded-hidden-probe');
			const input = page.locator('#caller .stanza-editor-input');
			const node = await zone.elementHandle();
			await expect(block).toHaveCSS('height', '140px');
			await expect(inline).toHaveText(['klmnopqrst']);
			await expect(hidden).toHaveText('x');

			await page.locator('#caller .ash-icon-folding-expanded').first().click();
			await expect(hidden).toHaveCount(0);
			await expect(block).toHaveCSS('height', showInHiddenAreas ? '100px' : '60px');
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ wordWrapColumn: 5 }));
			await expect(inline).toHaveText(['klmno', 'pqrst']);
			await expect(block).toHaveCSS('height', showInHiddenAreas ? '140px' : '100px');
			if (showInHiddenAreas) {
				await expect(zone).toHaveAttribute('data-top', '100');
				await expect(margin).toHaveCSS('top', '100px');
			} else {
				await expect(zone).toBeHidden();
				await expect(zone).toHaveAttribute('data-computed-height', '0');
			}

			await input.focus();
			await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(40));
			await expect(block).toHaveCSS('top', '-40px');
			if (showInHiddenAreas) {
				await expect(zone).toHaveAttribute('data-top', '60');
				const zoneBounds = await zone.boundingBox();
				const marginBounds = await margin.boundingBox();
				expect(zoneBounds?.y).toBe(marginBounds?.y);
			}
			await expect(input).toBeFocused();
			await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(200));
			await expect(zone).toBeHidden();
			await expect(margin).toBeHidden();
			await expect(block).toHaveCount(0);
			await expect(inline).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.scrollVisibleRows(0));
			await expect(block).toHaveCSS('height', showInHiddenAreas ? '140px' : '100px');
			await expect(inline).toHaveText(['klmno', 'pqrst']);
			expect(await node!.evaluate(element => element === document.querySelector('#caller .ash-folded-zone-probe'))).toBe(true);

			await page.evaluate(() => window.ashStandaloneIntegration.resizeViewZone(0, 2));
			await expect(zone).toBeHidden();
			await expect(margin).toBeHidden();
			await expect(block).toHaveCSS('height', '100px');
			await page.evaluate(() => window.ashStandaloneIntegration.resizeViewZone(40, 2));
			await expect(block).toHaveCSS('height', showInHiddenAreas ? '140px' : '100px');
			await page.locator('#caller .ash-icon-folding-collapsed').first().click();
			await expect(block).toHaveCSS('height', '180px');
			await expect(hidden).toHaveText('x');
			await expect(zone).toHaveAttribute('data-top', '120');
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ wordWrapColumn: 10 }));
			await expect(block).toHaveCSS('height', '140px');
			await expect(inline).toHaveText(['klmnopqrst']);
			await expect(zone).toHaveAttribute('data-top', '80');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion())).toBe(version);
			await input.focus();
			await page.evaluate(() => window.ashStandaloneIntegration.removeViewZone());
			await expect(zone).toHaveCount(0);
			await expect(margin).toHaveCount(0);
			await expect(block).toHaveCSS('height', '100px');
			await expect(input).toBeFocused();
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			await expect(block).toHaveCount(0);
			await expect(inline).toHaveCount(0);
			expect(await node!.evaluate(element => element.isConnected)).toBe(false);
			await node!.dispose();
			expect(errors).toEqual([]);
		});
	}

	test('clicking the clipped end of a long line reveals its remaining text', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLongLine());
		const line = page.locator('#caller .view-line').first();
		await expect(line).toContainText('01234567');
		await expect(line).not.toContainText('abcdefghij');
		const clickCharacter = async (character: string) => {
			const point = await line.evaluate((element, value) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let node: Node | null;
				while ((node = walker.nextNode())) {
					const offset = node.textContent?.indexOf(value) ?? -1;
					if (offset < 0) continue;
					const range = document.createRange();
					range.setStart(node, offset);
					range.setEnd(node, offset + 1);
					const rect = range.getBoundingClientRect();
					return { x: rect.right - 1, y: rect.top + rect.height / 2 };
				}
				throw new Error(`Character ${value} is not rendered`);
			}, character);
			await page.mouse.click(point.x, point.y);
		};
		await clickCharacter('2');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLongLineLimit())).toBe(8);
		await clickCharacter('7');
		await expect(line).toContainText('0123456789abcdefghij');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLongLineLimit())).toBe(-1);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('in-place replacement selects the complete new value from a real keyboard shortcut', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInPlaceReplace());
		await page.keyboard.press('Control+Shift+.');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({
			value: 'flag false', selections: ['[1,6 -> 1,11]'],
		});
		await page.keyboard.press('Control+Shift+,');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({
			value: 'flag true', selections: ['[1,6 -> 1,10]'],
		});
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('editor rendering follows updated configuration without replacing the view', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const root = page.locator('#caller .stanza-editor');
		const minimap = page.locator('#caller .minimap');
		const node = await root.elementHandle();
		const version = await page.evaluate(() => window.ashStandaloneIntegration.getCallerVersion());
		for (const enabled of [false, true, false]) {
			expect(await page.evaluate(value => window.ashStandaloneIntegration.updateRenderingOptions(value), enabled)).toBe(version);
			await expect(minimap).toBeVisible({ visible: enabled });
			await expect(root).toHaveCSS('font-size', enabled ? '18px' : '14px');
			await expect(root).toHaveClass(enabled ? /stanza-editor-mouse-copy/ : /stanza-editor-mouse-default/);
			if (enabled) {
				await expect(root).toHaveClass(/word-wrapped/);
				await expect(minimap).toHaveCSS('left', '0px');
			} else {
				await expect(root).not.toHaveClass(/word-wrapped/);
			}
		}
		expect(await node!.evaluate(element => element === document.querySelector('#caller .stanza-editor'))).toBe(true);
		await node!.dispose();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('editor configuration widens and shrinks the line-number gutter while typing and undoing', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCountConfiguration(9, 'fit'));
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		await page.keyboard.press('Enter');
		const after = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		expect(after.lines).toBe(10);
		expect(after.layout.lineNumbersWidth).toBe(Math.round(2 * after.digitWidth));
		expect(after.layout.contentLeft).toBeGreaterThan(before.layout.contentLeft);
		await expect(page.locator('#caller .line-numbers').last()).toHaveCSS('width', `${after.layout.lineNumbersWidth}px`);
		await page.keyboard.press('ControlOrMeta+z');
		const undone = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		expect(undone.lines).toBe(9);
		expect(undone.layout.lineNumbersWidth).toBe(before.layout.lineNumbersWidth);
		await expect(page.locator('#caller .line-numbers').last()).toHaveCSS('width', `${before.layout.lineNumbersWidth}px`);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	for (const size of ['fill', 'fit'] as const) {
		test(`editor configuration keeps ${size} minimap in sync with folded and wrapped lines`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.stack ?? error.message));
			await page.goto('/standalone.html');
			await page.evaluate(size => window.ashStandaloneIntegration.prepareLineCountConfiguration(1000, size), size);
			const initial = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
			expect(initial.layout.minimap.minimapIsSampling).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.foldConfigurationLines(true));
			const folded = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
			expect(folded.viewLines).toBe(2);
			expect(folded.layout.minimap.minimapIsSampling).toBe(false);
			await page.evaluate(() => window.ashStandaloneIntegration.foldConfigurationLines(false));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration())).layout.minimap).toEqual(initial.layout.minimap);

			await page.evaluate(size => window.ashStandaloneIntegration.prepareLineCountConfiguration(80, size, 'content '.repeat(30)), size);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ wordWrap: 'on' }));
			await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration())).layout.minimap.minimapIsSampling).toBe(true);
			const wrapped = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
			expect(wrapped.viewLines).toBeGreaterThan(wrapped.lines);
			await expect(page.locator('#caller .minimap')).toHaveCSS('width', `${wrapped.layout.minimap.minimapWidth}px`);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ wordWrap: 'off' }));
			await expect.poll(async () => (await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration())).viewLines).toBe(80);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			expect(errors).toEqual([]);
		});
	}

	test('editor configuration wraps an attached long-line file for screen readers and respects explicit off', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.configureAccessibility(true, 'auto'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLineCountConfiguration(1, 'fit', 'x'.repeat(20000)));
		const wrapped = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		expect(wrapped.layout.isWordWrapMinified).toBe(true);
		expect(wrapped.viewLines).toBeGreaterThan(1);
		await page.evaluate(() => window.ashStandaloneIntegration.configureAccessibility(true, 'off'));
		const unwrapped = await page.evaluate(() => window.ashStandaloneIntegration.readLineCountConfiguration());
		expect(unwrapped.layout.isWordWrapMinified).toBe(false);
		expect(unwrapped.viewLines).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('editor font measurements stay in layout pixels when the host is transformed', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const before = await page.evaluate(() => window.ashStandaloneIntegration.readFontMetrics());
		expect(before.halfwidth).toBeGreaterThan(2);
		for (const scale of [0.75, 1.5, 1]) {
			const after = await page.evaluate(scale => {
				document.body.style.transform = `scale(${scale})`;
				return window.ashStandaloneIntegration.readFontMetrics();
			}, scale);
			expect(after).toEqual(before);
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('editor accessibility configuration follows the host and honors per-editor overrides', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		const input = page.locator('#caller .stanza-native-edit-context');
		const mirror = page.locator('#caller .stanza-native-screen-reader-content');
		for (const [host, option, enabled] of [
			[true, 'auto', true],
			[true, 'off', false],
			[true, 'auto', true],
			[false, 'auto', false],
			[false, 'on', true],
		] as const) {
			expect(await page.evaluate(([host, option]) => window.ashStandaloneIntegration.configureAccessibility(host, option), [host, option] as const))
				.toEqual({ support: enabled ? 2 : 1, indent: enabled ? 0 : 2 });
			await expect(mirror).toHaveAttribute('aria-hidden', enabled ? 'false' : 'true');
			await expect(input).toBeFocused();
		}
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	for (const [original, formatted] of [['😀 hello', '😀 Hello'], ['a😀z', 'a😁z'], ['a😀z', 'a🨀z'], ['first\n😀 hello', 'first\n😀 Hello']]) {
		test(`formatting preserves UTF-16 characters: ${JSON.stringify(original)} to ${JSON.stringify(formatted)}`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			expect(await page.evaluate(([before, after]) => window.ashStandaloneIntegration.runUnicodeFormatting(before!, after!), [original, formatted])).toBe(formatted);
			await page.keyboard.press('ControlOrMeta+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(original);
			await page.keyboard.press('ControlOrMeta+Shift+z');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(formatted);
		});
	}

	for (const change of ['none', 'position', 'model', 'readonly', 'eol', 'returnPosition'] as const) {
		test(`formatting validates ${change} state before applying delayed edits`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			const value = await page.evaluate(change => window.ashStandaloneIntegration.runFormatting(change), change);
			expect(value).toBe(change === 'eol' ? '\r\n' : change === 'none' ? 'ALPHA' : change === 'model' ? 'owned' : 'alpha');
			if (change === 'eol') {
				await page.keyboard.press('ControlOrMeta+z');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\n');
				await page.keyboard.press('ControlOrMeta+Shift+z');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\r\n');
			}
			if (change === 'none') {
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('alpha');
				await page.keyboard.press('ControlOrMeta+Shift+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe('ALPHA');
			}
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	for (const cancel of ['escape', 'supersede'] as const) {
		test(`format action cancels pending provider on ${cancel}`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => window.ashStandaloneIntegration.prepareDeferredFormatting());
			await page.keyboard.press('ControlOrMeta+Shift+i');
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting())).toEqual({ aborted: [false], value: 'alpha' });
			if (cancel === 'escape') {
				await page.keyboard.press('Escape');
			} else {
				await page.evaluate(() => { void window.ashStandaloneIntegration.runLineAction('editor.action.formatDocument'); });
			}
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting())).toEqual({ aborted: cancel === 'escape' ? [true] : [true, false], value: 'alpha' });
			await page.evaluate(() => window.ashStandaloneIntegration.finishDeferredFormatting());
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDeferredFormatting().value)).toBe(cancel === 'escape' ? 'alpha' : 'ALPHA');
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	for (const mode of ['ranges', 'single', 'empty', 'cancel', 'readonly'] as const) {
		test(`selection formatting handles ${mode} through the registered action`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			const result = await page.evaluate(mode => window.ashStandaloneIntegration.runSelectionFormatting(mode), mode);
			const original = 'alpha\nbeta\ngamma';
			if (mode === 'cancel' || mode === 'readonly') {
				expect(result.value).toBe(original);
				if (mode === 'cancel') expect(result.cancelled).toBe(true);
				if (mode === 'readonly') expect(result.ranges).toEqual([]);
			} else {
				expect(result.value).toBe(mode === 'empty' ? 'alpha\nBETA\ngamma' : 'ALPHA\nbeta\nGAMMA');
				expect(result.ranges).toEqual(mode === 'empty' ? ['[2,1 -> 2,5]'] : ['[1,1 -> 1,6]', '[3,1 -> 3,6]']);
				await page.keyboard.press('ControlOrMeta+z');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe(original);
			}
		});
	}

	for (const cancel of [false, true]) {
		test(`overlapping formatting re-queries the combined range${cancel ? ' and cancels' : ' before one undoable edit'}`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			const result = await page.evaluate(cancel => window.ashStandaloneIntegration.runOverlappingFormatting(cancel), cancel);
			expect(result).toEqual({
				value: cancel ? 'alpha\nbeta\ngamma' : 'ALPHA\nBETA\nGAMMA',
				ranges: ['[1,1 -> 1,6]', '[3,1 -> 3,6]', '[1,1 -> 3,6]'],
				cancelled: cancel,
			});
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readEOL())).toBe('\n');
			if (!cancel) {
				await page.keyboard.press('ControlOrMeta+z');
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy().value)).toBe('alpha\nbeta\ngamma');
			}
		});
	}

	for (const outcome of ['second', 'empty', 'decline', 'error', 'cancel', 'silent', 'languageChoice', 'languageResult'] as const) {
		test(`formatter selection honors ${outcome} without running another provider`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			const result = await page.evaluate(outcome => window.ashStandaloneIntegration.runFormatterChoice(outcome), outcome);
			expect(result).toEqual({
				value: outcome === 'second' || outcome === 'silent' ? 'SELECTED' : 'alpha',
				calls: outcome === 'decline' || outcome === 'cancel' || outcome === 'languageChoice' ? [] : ['selected'],
				modes: [outcome === 'silent' ? 2 : 1],
				errors: outcome === 'error' ? ['formatter failed'] : [],
			});
		});
	}


	test('inline suggestions respect automatic enablement and cancel disabled requests', async function () {
		const { page } = browserTests;

		await page.clock.install();
		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ inlineSuggest: { enabled: false } });
			window.ashStandaloneIntegration.prepareInlineRequests();
		});
		await page.keyboard.type('abc');
		await page.clock.runFor(600);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ inlineSuggest: { enabled: true } }));
		await page.keyboard.type('d');
		await page.clock.runFor(600);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toHaveLength(1);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ inlineSuggest: { enabled: false } }));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests[0]!.aborted).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
		await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeHidden();
		await page.keyboard.press('Control+Alt+Space');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests[1]!.kind).toBe('explicit');
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
		await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ readOnly: true }));
		await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeHidden();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standard contribution commands operate the existing find, fold and goto widgets', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('alpha\n  child\nend'));
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('actions.find'));
		const find = page.locator('#caller .stanza-editor-find-widget');
		await expect(find).toBeVisible();
		await find.getByRole('textbox', { name: 'Find', exact: true }).fill('alpha');
		await expect(find.locator('.stanza-editor-find-result')).toHaveText('1 of 1');
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.startFindReplaceAction'));
		await expect(find.getByRole('textbox', { name: 'Replace', exact: true })).toBeVisible();
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.fold'));
		await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.unfold'));
		await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(1);
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.gotoLine'));
		const location = page.locator('#caller .stanza-editor-goto-line-input');
		await expect(location).toBeFocused();
		await location.fill('3:2');
		await page.keyboard.press('Enter');
		await expect(location).toBeHidden();
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.keyboard.type('X');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('alpha\n  child\neXnd');
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.gotoOffset'));
		await expect(location).toBeFocused();
		await expect(location).toHaveAttribute('aria-label', 'Character offset');
		await location.fill('7');
		await page.keyboard.press('Enter');
		await expect(location).toBeHidden();
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.keyboard.type('Y');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('alpha\nY  child\neXnd');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('standard suggestion commands trigger, hide and commit through one undoable edit', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareContributionRequests('completion');
			window.ashStandaloneIntegration.invokeLanguageAction('editor.action.triggerSuggest');
		});
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishContributionRequest(0));
		await expect(page.locator('#caller .stanza-editor-completion')).toBeVisible();
		await page.keyboard.press('Escape');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareInlineRequests();
			window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.trigger');
		});
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests().requests.length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
		const ghost = page.locator('#caller .stanza-editor-inline-completion');
		await expect(ghost).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.hide'));
		await expect(ghost).toBeHidden();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('');
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.trigger'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests().requests.length)).toBe(2);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
		await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('editor.action.inlineSuggest.commit'));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(' suggestion');
		await expect(ghost).toBeHidden();
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('inline completion snooze is shared and survives closing another editor', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.runSharedInlineSnooze())).toEqual({
			shared: true,
			visibleBefore: 2,
			visibleAfter: 0,
			callsWhilePaused: 0,
			pausedAfterDispose: true,
			resumed: true,
		});
	});

	test('inline completion uses the new language after cancelling an old request', async function () {
		const { page } = browserTests;

		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/standalone.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
		await page.keyboard.type('a');
		await page.clock.runFor(50);
		await page.evaluate(() => window.ashStandaloneIntegration.cancelInlineRequests('language'));
		await page.keyboard.type('b');
		await page.clock.runFor(50);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).requests).toEqual([
			{ kind: 'automatic', text: 'a', languageId: 'plaintext', aborted: true },
			{ kind: 'automatic', text: 'ab', languageId: 'typescript', aborted: false },
		]);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('inline completion ignores late responses after more typing', async function () {
		const { page } = browserTests;

		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/standalone.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
		await page.keyboard.type('a');
		await page.clock.runFor(200);
		await page.keyboard.type('b');
		await page.clock.runFor(50);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests())).toEqual({
			requests: [{ kind: 'automatic', text: 'a', languageId: 'plaintext', aborted: true }, { kind: 'automatic', text: 'ab', languageId: 'plaintext', aborted: false }],
			delay: 50,
			shared: true,
		});
		await expect(page.locator('#caller .stanza-editor-inline-completion:not([hidden])')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(1));
		await expect(page.locator('#caller .stanza-editor-inline-completion')).toBeVisible();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	for (const reason of ['position', 'provider', 'snooze', 'dispose', 'model', 'blur', 'language'] as const) {
		for (const queued of [true, false]) {
			test(`inline completion ${queued ? 'queued' : 'running'} request is cancelled on ${reason}`, async function () {
				const { page } = browserTests;

				const errors: string[] = [];
				page.on('pageerror', error => errors.push(error.message));
				await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
				await page.goto('/standalone.html');
				await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
				await page.evaluate(() => window.ashStandaloneIntegration.prepareInlineRequests());
				await page.keyboard.type('abc');
				if (!queued) {
					await page.clock.runFor(50);
				}
				await page.evaluate(reason => window.ashStandaloneIntegration.cancelInlineRequests(reason), reason);
				await page.clock.runFor(1_000);
				const state = await page.evaluate(() => window.ashStandaloneIntegration.readInlineRequests());
				expect(state.requests).toEqual(queued ? [] : [{ kind: 'automatic', text: 'abc', languageId: 'plaintext', aborted: true }]);
				expect(state.delay).toBe(50);
				if (!queued) {
					await page.evaluate(() => window.ashStandaloneIntegration.finishInlineRequest(0));
				}
				await expect(page.locator('#caller .stanza-editor-inline-completion:not([hidden])')).toHaveCount(0);
				await page.evaluate(() => window.ashStandaloneIntegration.dispose());
				expect(errors).toEqual([]);
			});
		}
	}


	test('standalone without a grammar keeps plain text and no invented diagnostics while word suggestions work', async function () {
		const { page } = browserTests;

		const workers: string[] = [];
		page.on('worker', worker => workers.push(worker.url()));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLanguageWorkers());
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageWorkers())).toEqual({
			tokens: [],
			diagnostics: [],
			current: true,
		});
		await page.keyboard.press('Control+Space');
		await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
		await expect(page.locator('#caller .stanza-editor-completion-option')).toContainText(['alpha', 'alphabet']);
		expect(workers.some(url => url.includes('editorWebWorkerMain'))).toBe(true);
		expect(workers.some(url => /syntaxWorkerMain|languageCompletionWorkerMain/.test(url))).toBe(false);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});


	for (const scenario of [
		{ name: 'nested', value: 'let x = ; tail', insertText: 'call({x: [1', column: 9, tokenType: 'other', completeBracketPairs: true, repaired: 'call({x: [1]})', result: 'let x = call({x: [1]}); tail' },
		{ name: 'unexpected closing', value: 'let x = ; tail', insertText: 'value)]', column: 9, tokenType: 'other', completeBracketPairs: true, repaired: 'value', result: 'let x = value; tail' },
		{ name: 'string', value: 'let x = "', insertText: '[)', column: 10, tokenType: 'string', completeBracketPairs: true, repaired: '[)', result: 'let x = "[)' },
		{ name: 'comment', value: '// ', insertText: '[)', column: 4, tokenType: 'comment', completeBracketPairs: true, repaired: '[)', result: '// [)' },
		{ name: 'multiline', value: 'let x = ;', insertText: 'call(\n[1', column: 9, tokenType: 'other', completeBracketPairs: true, repaired: 'call(\n[1])', result: 'let x = call(\n[1]);' },
		{ name: 'explicit replacement', value: 'let x = old; tail', insertText: 'call(', column: 9, tokenType: 'other', completeBracketPairs: true, replaceLength: 3, repaired: 'call()', result: 'let x = call(); tail' },
		{ name: 'unavailable lexer', value: 'let x = ', insertText: 'call(', column: 9, tokenType: 'unavailable', completeBracketPairs: true, repaired: 'call(', result: 'let x = call(' },
		{ name: 'provider opt out', value: 'let x = ', insertText: 'call(', column: 9, tokenType: 'other', completeBracketPairs: false, repaired: 'call(', result: 'let x = call(' },
	] as const) {
		test(`inline completion bracket repair ${scenario.name} preserves suffix and accepts with one undo`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			await page.evaluate(scenario => window.ashStandaloneIntegration.prepareBracketCompletion(scenario.value, scenario.insertText, scenario.column, scenario.tokenType, scenario.completeBracketPairs, 'replaceLength' in scenario ? scenario.replaceLength : 0), scenario);
			await page.keyboard.press('Control+Alt+Space');
			const ghost = page.locator('#caller .stanza-editor-inline-completion');
			await expect(ghost).toBeVisible();
			expect(await ghost.textContent()).toBe(scenario.repaired);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe(scenario.value);
			await page.keyboard.press('Alt+Enter');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('/* accepted */ ' + scenario.result);
			await page.keyboard.press('ControlOrMeta+z');
			expect(await page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe(scenario.value);
			await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
			expect(errors).toEqual([]);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test('color picker retains one widget, applies one undoable edit and releases its controls', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker());
		await page.keyboard.press('ControlOrMeta+Shift+c');
		const picker = page.locator('.stanza-editor-color-picker').first();
		await expect(picker).toBeVisible();
		await expect(picker.locator('.stanza-editor-color-picker-presentation option')).toHaveCount(3);
		await picker.evaluate(element => { element.dataset.retained = 'true'; });
		const hue = picker.getByRole('slider', { name: 'Hue', exact: true });
		await hue.focus();
		await hue.evaluate(element => {
			(element as HTMLInputElement).value = '119';
			element.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await hue.press('ArrowRight');
		await expect(picker.getByRole('combobox', { name: 'Document color format' })).toHaveValue('#00ff0080');
		await picker.getByRole('button', { name: 'Apply', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #00ff0080;');
		await expect(picker).toBeHidden();
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #ff000080;');
		await page.locator('#caller .colorpicker-color-decoration').click();
		await expect(picker).toBeVisible();
		await expect(picker).toHaveAttribute('data-retained', 'true');
		await page.keyboard.press('Escape');
		await expect(picker).toBeHidden();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		await expect(picker).toHaveCount(0);
		expect(errors).toEqual([]);
	});

	test('color picker shares the base controls, captures pointer drags and cancels without changing the document', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker());
		await page.keyboard.press('ControlOrMeta+Shift+c');
		const picker = page.locator('.stanza-editor-color-picker').first();
		const area = picker.getByRole('slider', { name: 'Saturation and brightness' });
		await expect(area).toBeFocused();
		await expect(picker.getByRole('dialog')).toHaveCount(0);
		await expect(picker.locator('.ash-color-picker')).toHaveAttribute('role', 'group');
		await expect(area).toHaveCSS('outline-style', 'solid');
		const bounds = await area.boundingBox();
		expect(bounds).not.toBeNull();
		await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds!.x + bounds!.width + 20, bounds!.y - 20, { steps: 4 });
		await page.mouse.up();
		await expect(area).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');
		await expect(picker.getByRole('combobox', { name: 'Document color format' })).toHaveValue('#ff000080');
		await area.press('ArrowLeft');
		await expect(area).toHaveAttribute('aria-valuetext', 'Saturation 99%, brightness 100%');
		await picker.getByRole('button', { name: 'Restore original color' }).click();
		await expect(area).toHaveAttribute('aria-valuetext', 'Saturation 100%, brightness 100%');
		await area.evaluate(element => element.addEventListener('gotpointercapture', event => {
			(element as HTMLElement).dataset.pointerId = String((event as PointerEvent).pointerId);
		}, { once: true }));
		await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds!.x + bounds!.width / 2 + 1, bounds!.y + bounds!.height / 2);
		expect(await area.evaluate(element => element.hasPointerCapture(Number((element as HTMLElement).dataset.pointerId)))).toBe(true);
		await page.keyboard.press('Escape');
		await expect(picker).toBeHidden();
		expect(await picker.locator('.ash-color-picker-area').evaluate(element => element.hasPointerCapture(Number((element as HTMLElement).dataset.pointerId)))).toBe(false);
		await page.mouse.up();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #ff000080;');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('color picker commands insert at the selection and preserve the chosen document format', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('color: token;', [[1, 8, 1, 13]]));
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.showOrFocusStandaloneColorPicker'));
		const picker = page.locator('.stanza-editor-color-picker').first();
		await expect(picker).toBeVisible();
		const documentFormat = picker.getByRole('combobox', { name: 'Document color format' });
		await documentFormat.selectOption('#ffffff');
		await picker.getByRole('combobox', { name: 'Color format', exact: true }).selectOption('hex');
		await picker.getByRole('textbox', { name: 'Color value' }).fill('00ff00');
		await picker.getByRole('textbox', { name: 'Color value' }).press('Enter');
		await expect(documentFormat).toHaveValue('#00ff00');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.showOrFocusStandaloneColorPicker'));
		await expect(picker.getByRole('slider', { name: 'Saturation and brightness' })).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.insertColorWithStandaloneColorPicker'));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('color: #00ff00;');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('color: token;');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('color picker popup follows all themes outside the editor clipping region and closes when read-only changes', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker());
		await page.keyboard.press('ControlOrMeta+Shift+c');
		const picker = page.locator('.stanza-editor-color-picker').first();
		await expect(picker).toBeVisible();
		const editorBounds = await page.locator('#caller').boundingBox();
		const pickerBounds = await picker.boundingBox();
		expect(pickerBounds!.y + pickerBounds!.height).toBeGreaterThan(editorBounds!.y + editorBounds!.height);
		for (const theme of ['ash-dark', 'ash-light', 'ash-high-contrast-dark', 'ash-high-contrast-light']) {
			await page.evaluate(theme => window.ashStandaloneIntegration.setActionMenuTheme(theme), theme);
			await expect(page.locator('html')).toHaveAttribute('data-color-theme', theme);
			const background = await picker.evaluate(element => {
				const probe = document.createElement('span');
				probe.style.color = 'var(--ash-editor-widgetBackground)';
				element.append(probe);
				try { return getComputedStyle(probe).color; } finally { probe.remove(); }
			});
			await expect(picker).toHaveCSS('background-color', background);
			await expect(picker).toHaveCSS('font-size', '12px');
			await expect(picker).toHaveCSS('border-radius', '8px');
			if (theme.includes('high-contrast')) {
				await expect(picker).toHaveCSS('box-shadow', 'none');
				await expect(picker).toHaveCSS('border-style', 'solid');
			}
		}
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ readOnly: true }));
		await expect(picker).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #ff000080;');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('color picker inserts at every selection in one undo step and hover activation respects editor options', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('one two', [[1, 1, 1, 4], [1, 5, 1, 8]]));
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+Shift+c');
		const picker = page.locator('.stanza-editor-color-picker').first();
		await expect(picker).toBeVisible();
		await picker.getByRole('combobox', { name: 'Document color format' }).selectOption('#ffffff');
		await picker.getByRole('button', { name: 'Apply', exact: true }).click();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('#ffffff #ffffff');
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('one two');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareColorPicker();
			window.ashStandaloneIntegration.updateContributionOptions({ colorDecoratorsActivatedOn: 'hover' });
		});
		const swatch = page.locator('#caller .colorpicker-color-decoration');
		await swatch.hover();
		await expect(picker).toBeVisible();
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ colorDecoratorsActivatedOn: 'click' }));
		await expect(picker).toBeHidden();
		await swatch.click();
		await expect(picker).toBeVisible();
		await page.keyboard.press('Escape');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('color hover shares documentation, commits finished gestures and follows changed document ranges', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker(true));
		await page.locator('#caller .colorpicker-color-decoration').click();
		const hover = page.locator('.stanza-editor-hover.interactive');
		const picker = hover.locator('.stanza-editor-color-picker');
		await expect(picker).toBeVisible();
		await expect(hover.locator('.stanza-editor-hover-content')).toHaveText('Color documentation');
		await expect(picker.getByRole('button', { name: 'Apply', exact: true })).toHaveCount(0);
		const hue = picker.getByRole('slider', { name: 'Hue', exact: true });
		await hue.focus();
		await hue.evaluate(element => {
			(element as HTMLInputElement).value = '119';
			element.dispatchEvent(new Event('input', { bubbles: true }));
		});
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #ff000080;');
		await hue.press('ArrowRight');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #00ff0080;');
		await expect(picker).toBeVisible();
		const format = picker.getByRole('combobox', { name: 'Document color format' });
		await expect(format).toBeEnabled();
		await format.selectOption('rgba(0, 255, 0, 0.502)');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = rgba(0, 255, 0, 0.502);');
		await expect(format).toBeEnabled();
		await format.selectOption('#00ff0080');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #00ff0080;');
		const area = picker.getByRole('slider', { name: 'Saturation and brightness' });
		const bounds = (await area.boundingBox())!;
		await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
		await page.mouse.down();
		await page.mouse.move(bounds.x + bounds.width / 4, bounds.y + bounds.height / 4);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #00ff0080;');
		await page.mouse.up();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).not.toBe('const color = #00ff0080;');
		await expect(picker).toBeVisible();
		await area.press('Escape');
		await expect(hover).toHaveCount(0);
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #00ff0080;');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		expect(errors).toEqual([]);
	});

	test('color picker Enter uses its editor focus context and color text Enter confirms input', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker());
		await page.keyboard.press('ControlOrMeta+Shift+c');
		const picker = page.locator('.stanza-editor-color-picker').first();
		const value = picker.getByRole('textbox', { name: 'Color value' });
		await value.fill('00ff0080');
		await value.press('Enter');
		await expect(picker.getByRole('combobox', { name: 'Document color format' })).toHaveValue('#00ff0080');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #ff000080;');
		const area = picker.getByRole('slider', { name: 'Saturation and brightness' });
		await area.focus();
		await area.press('Enter');
		await expect(picker).toBeHidden();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #00ff0080;');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.keyboard.press('ControlOrMeta+z');
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.showHover'));
		const hoverPicker = page.locator('.stanza-editor-hover.interactive .stanza-editor-color-picker');
		await expect(hoverPicker.getByRole('slider', { name: 'Saturation and brightness' })).toBeFocused();
		await expect(page.getByRole('region', { name: 'Editor hover' })).toBeVisible();
		await expect(page.locator('#caller .stanza-editor-accessibility-status')).toHaveText('Press Alt+F1 for color picker help.');
		await page.keyboard.press('Escape');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('color provider commands query loaded models, return formats and reject invalid arguments', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker());
		const colors = await page.evaluate(() => window.ashStandaloneIntegration.executeColorCommand('_executeDocumentColorProvider'));
		expect(colors).toEqual([{ range: { startLineNumber: 1, startColumn: 15, endLineNumber: 1, endColumn: 24 }, color: [1, 0, 0, 128 / 255] }]);
		const formats = await page.evaluate(() => window.ashStandaloneIntegration.executeColorCommand('_executeColorPresentationProvider', [0, 1, 0, 1], [1, 15, 1, 24])) as { label: string; textEdit: { text: string; }; }[];
		expect(formats.map(format => [format.label, format.textEdit.text])).toEqual([['rgb(0, 255, 0)', 'rgb(0, 255, 0)'], ['hsl(120, 100%, 50%)', 'hsl(120, 100%, 50%)'], ['#00ff00', '#00ff00']]);
		expect(await page.evaluate(async () => {
			try { await window.ashStandaloneIntegration.executeColorCommand('_executeColorPresentationProvider', [2, 0, 0, 1], [1, 15, 1, 24]); return ''; }
			catch (error) { return (error as Error).message; }
		})).toContain('four color components');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('color picker overflow focus routes Enter to its owning editor after another editor was active', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareColorPicker());
		const otherValue = await page.evaluate(() => window.ashStandaloneIntegration.state('owned').value);
		await page.locator('#owned .stanza-editor-input').focus();
		await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.action.showOrFocusStandaloneColorPicker'));
		const picker = page.locator('.stanza-editor-color-picker:not([hidden])');
		const opacity = picker.getByRole('slider', { name: 'Opacity', exact: true });
		await opacity.focus();
		await opacity.press('Home');
		await expect(picker.getByRole('combobox', { name: 'Document color format' })).toHaveValue('#ff000000');
		await opacity.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.state('caller').value)).toBe('const color = #ff000000;');
		expect(await page.evaluate(() => window.ashStandaloneIntegration.state('owned').value)).toBe(otherValue);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('hover options control requests, delay and keyboard modifiers', async function () {
		const { page } = browserTests;

		await page.clock.install({ time: new Date('2026-01-01T00:00:00Z') });
		await page.goto('/standalone.html');
		await page.clock.pauseAt(new Date('2026-01-01T00:01:00Z'));
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'off', delay: 900 } });
			window.ashStandaloneIntegration.prepareLanguageRequest('hover');
		});
		const point = await page.evaluate(() => window.ashStandaloneIntegration.contributionPoint(2));
		await page.mouse.move(point.x, point.y);
		await page.clock.runFor(1000);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'on' } }));
		await page.clock.runFor(899);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([]);
		await page.clock.runFor(1);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(1);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'off' } }));
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests()))[0]!.aborted).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		const hover = page.locator('.stanza-editor-hover').first();
		await expect(hover).toBeHidden();
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ hover: { enabled: 'onKeyboardModifier', delay: 0 }, multiCursorModifier: 'ctrlCmd' }));
		await page.clock.runFor(1);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(1);
		await page.keyboard.down('Alt');
		await page.clock.runFor(1);
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(2);
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(1));
		await page.clock.runFor(16);
		await expect(hover).toBeVisible();
		await page.keyboard.up('Alt');
		await expect(hover).toBeHidden();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	suite('folding command routing', () => {
		const text = 'first\n  inner\n    body\n  sibling\nsecond\n  inner\n    body\n  sibling\nlast';

		teardown(async function () {
			const { page } = browserTests;

			await page.evaluate(() => window.ashStandaloneIntegration?.dispose());
		});

		test('default folding provider changes refresh ranges and preserve keyboard focus', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(() => {
				window.ashStandaloneIntegration.prepareFoldingProviders();
				window.ashStandaloneIntegration.selectFoldingProvider('test.first');
			});
			const input = page.locator('#caller .stanza-editor-input');
			const lines = page.locator('#caller .view-line');
			await input.focus();
			await expect(page.locator('#caller .stanza-editor-line-decoration.ash-icon-folding-expanded')).toHaveCount(1);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold'));
			await expect(lines).toHaveCount(3);
			await expect(page.locator('#caller .view-line[data-logical-line-index="1"]')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldAll'));
			await page.evaluate(() => window.ashStandaloneIntegration.selectFoldingProvider('test.second'));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readFoldingProviderRanges())).toEqual([[2, 4]]);
			await expect(page.locator('#caller .stanza-editor-line-decoration.ash-icon-folding-expanded')).toHaveCount(1);
			await page.evaluate(() => {
				window.ashStandaloneIntegration.setFoldingSelections([[2, 1, 2, 1]]);
			});
			await input.press(process.platform === 'darwin' ? 'Meta+Alt+[' : 'Control+Shift+[');
			await expect(lines).toHaveCount(3);
			await expect(page.locator('#caller .view-line[data-logical-line-index="2"]')).toHaveCount(0);
			await expect(input).toBeFocused();
			await page.evaluate(() => window.ashStandaloneIntegration.selectFoldingProvider('test.unavailable'));
			await expect(lines).toHaveCount(5);
			await expect(page.locator('#caller .stanza-editor-line-decoration.ash-icon-folding-expanded')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.selectFoldingProvider(null));
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readFoldingProviderRanges())).toEqual([[1, 3]]);
			await expect(page.locator('#caller .stanza-editor-line-decoration.ash-icon-folding-expanded')).toHaveCount(1);
			await expect(input).toBeFocused();
		});

		test('saved editor view state restores collapsed lines', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, text);
			const lines = page.locator('#caller .view-line');
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldAll'));
			await expect(lines).toHaveCount(3);
			await page.evaluate(() => window.ashStandaloneIntegration.saveFoldingViewState());
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldAll'));
			await expect(lines).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.restoreFoldingViewState());
			await expect(lines).toHaveCount(3);
		});

		test('recursive and all actions update every selected scope, including read-only editors', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1], [5, 1, 5, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation', readOnly: true });
			}, text);
			const lines = page.locator('#caller .view-line');
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldRecursively'));
			await expect(lines).toHaveCount(3);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold'));
			await expect(lines).toHaveCount(7);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldRecursively'));
			await expect(lines).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldAll'));
			await expect(lines).toHaveCount(3);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfoldAll'));
			await expect(lines).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: false }));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(false);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldAll'));
			await expect(lines).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ folding: true }));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.setFoldingModelAttached(false));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(false);
			await page.evaluate(() => window.ashStandaloneIntegration.setFoldingModelAttached(true));
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readFoldingCommandState())).supported).toBe(true);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldAll'));
			await expect(lines).toHaveCount(3);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(text);
		});

		test('level actions preserve the selected scope and do not collapse deeper levels', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[2, 1, 2, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, text);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldLevel2'));
			await expect(page.locator('#caller .view-line[data-logical-line-index="2"]')).toHaveCount(1);
			await expect(page.locator('#caller .view-line[data-logical-line-index="6"]')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.foldLevel1'));
			await expect(page.locator('#caller .view-line')).toHaveCount(6);
			await page.evaluate(() => {
				window.ashStandaloneIntegration.setFoldingSelections([[5, 1, 5, 1]]);
				window.ashStandaloneIntegration.invokeLanguageAction('editor.unfold');
			});
			await expect(page.locator('#caller .view-line')).toHaveCount(8);
			for (let level = 3; level <= 7; level++) {
				await page.evaluate(level => window.ashStandaloneIntegration.runLineAction(`editor.foldLevel${level}`), level);
			}
			await expect(page.locator('#caller .view-line')).toHaveCount(8);
		});

		test('manual range actions collapse each selection, preserve text and remove selected ranges', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			const value = 'one\ntwo\nthree\nfour\nfive\nsix\nseven';
			await page.evaluate(value => {
				window.ashStandaloneIntegration.prepareClipboard(value, [[1, 1, 4, 1], [5, 1, 6, 4]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, value);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.createFoldingRangeFromSelection'));
			await expect(page.locator('#caller .view-line')).toHaveCount(4);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[1,1 -> 1,1]', '[5,1 -> 5,1]']);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.removeManualFoldingRanges'));
			await expect(page.locator('#caller .view-line')).toHaveCount(7);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(value);
		});

		test('multiple cursors in one fold collapse it once before moving to the parent', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[2, 1, 2, 1], [3, 1, 3, 1], [6, 1, 6, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, text);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold'));
			await expect(page.locator('#caller .view-line')).toHaveCount(7);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold'));
			await expect(page.locator('#caller .view-line')).toHaveCount(3);
		});

		test('action arguments select zero-based lines and count levels in both directions', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, text);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			const lines = page.locator('#caller .view-line');
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 2, selectionLines: [4] }));
			await expect(lines).toHaveCount(6);
			await expect(page.locator('#caller .view-line[data-logical-line-index="2"]')).toHaveCount(1);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 1, selectionLines: [4] }));
			await expect(lines).toHaveCount(8);
			await expect(page.locator('#caller .view-line[data-logical-line-index="6"]')).toHaveCount(0);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 2, direction: 'up', selectionLines: [6] }));
			await expect(lines).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 2, direction: 'up', selectionLines: [2] }));
			await expect(lines).toHaveCount(6);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { selectionLines: [0] }));
			await expect(lines).toHaveCount(8);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { selectionLines: [1] }));
			await expect(lines).toHaveCount(9);
			expect(await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).toEqual({ value: text, selections: ['[1,1 -> 1,1]'] });
			await expect(input).toBeFocused();
		});

		test('explicit levels and direction keep repeated folds in the requested scope', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[5, 1, 5, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, text);
			const lines = page.locator('#caller .view-line');
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 0, selectionLines: [1, 2, 1] }));
			await expect(lines).toHaveCount(8);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { direction: 'down', selectionLines: [1] }));
			await expect(lines).toHaveCount(8);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { selectionLines: [1] }));
			await expect(lines).toHaveCount(6);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 0, selectionLines: [0] }));
			await expect(lines).toHaveCount(8);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 3, selectionLines: [-1, 99, 8] }));
			await expect(lines).toHaveCount(8);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).selections).toEqual(['[5,1 -> 5,1]']);
		});

		test('custom keybindings deliver folding arguments through the command service', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
				window.ashStandaloneIntegration.prepareFoldingKeybinding('editor.fold', { levels: 2, selectionLines: [4] });
			}, text);
			const input = page.locator('#caller .stanza-editor-input');
			await input.focus();
			await page.keyboard.press('F9');
			await page.keyboard.press('F10');
			await expect(page.locator('#caller .view-line')).toHaveCount(6);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { selectionLines: [4] }));
			await expect(page.locator('#caller .view-line')).toHaveCount(8);
			await expect(input).toBeFocused();
		});

		test('invalid folding arguments reject without changes and empty line lists retain their scope', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, text);
			const rejected = await page.evaluate(async () => {
				const errors: string[] = [];
				for (const command of ['editor.fold', 'editor.unfold']) {
					for (const args of [null, false, 0, '', [], 'invalid', { levels: '2' }, { levels: NaN }, { direction: 2 }, { selectionLines: [0, '4'] }]) {
						try {
							await window.ashStandaloneIntegration.runLineAction(command, args);
							errors.push('accepted');
						} catch (error) {
							errors.push((error as Error).name);
						}
					}
				}
				return errors;
			});
			expect(rejected).toEqual(Array(20).fill('TypeError'));
			const lines = page.locator('#caller .view-line');
			await expect(lines).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { selectionLines: [] }));
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 10, direction: 'up', selectionLines: [] }));
			await expect(lines).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.fold', { levels: 2, selectionLines: [] }));
			await expect(lines).toHaveCount(3);
			await page.evaluate(() => window.ashStandaloneIntegration.runLineAction('editor.unfold', { levels: 3, selectionLines: [] }));
			await expect(lines).toHaveCount(9);
		});

		test('command service rejects malformed folding arguments before changing editor state', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(text => {
				window.ashStandaloneIntegration.prepareClipboard(text, [[1, 1, 1, 1]]);
				window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			}, text);
			await page.locator('#caller .stanza-editor-input').focus();
			await page.evaluate(() => window.ashStandaloneIntegration.runFoldingCommand('editor.fold', { levels: 2, selectionLines: [4] }));
			await expect(page.locator('#caller .view-line')).toHaveCount(6);
			const errors = await page.evaluate(async () => {
				const rejected: string[] = [];
				for (const command of ['editor.fold', 'editor.unfold']) {
					for (const args of [null, false, 0, '', { levels: '2' }, { direction: false }, { selectionLines: [null] }]) {
						try {
							await window.ashStandaloneIntegration.runFoldingCommand(command, args);
							rejected.push('accepted');
						} catch (error) {
							rejected.push((error as Error).name);
						}
					}
				}
				return rejected;
			});
			expect(errors).toEqual(Array(14).fill('TypeError'));
			await expect(page.locator('#caller .view-line')).toHaveCount(6);
			await page.evaluate(() => window.ashStandaloneIntegration.runFoldingCommand('editor.unfold', { levels: 2, selectionLines: [4] }));
			await expect(page.locator('#caller .view-line')).toHaveCount(9);
			await page.evaluate(() => window.ashStandaloneIntegration.runFoldingCommand('editor.fold'));
			await expect(page.locator('#caller .view-line')).toHaveCount(6);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLineCopy())).value).toBe(text);
		});

		test('public folding actions expose argument descriptions and schemas', async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			const metadata = await page.evaluate(() => ['editor.fold', 'editor.unfold'].map(command => window.ashStandaloneIntegration.readFoldingMetadata(command)));
			expect(metadata.map(entry => entry.description)).toEqual([
				{ original: 'Collapse the selected folding ranges.', value: 'Collapse the selected folding ranges.' },
				{ original: 'Expand the selected folding ranges.', value: 'Expand the selected folding ranges.' },
			]);
			for (const [index, entry] of metadata.entries()) {
				expect(entry.args[0]?.name).toBe('Folding options');
				expect(entry.args[0]?.description).toContain('zero-based lines');
				expect(entry.args[0]?.schema).toEqual({
					type: 'object',
					properties: {
						levels: index === 0 ? { type: 'number' } : { type: 'number', default: 1 },
						direction: index === 0 ? { type: 'string', enum: ['up', 'down'] } : { type: 'string', enum: ['up', 'down'], default: 'down' },
						selectionLines: { type: 'array', items: { type: 'number' } },
					},
				});
			}
		});
	});

	test('folding strategy cancels providers and region limits update hidden lines', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation', showFoldingControls: 'always' });
			window.ashStandaloneIntegration.prepareContributionRequests('folding');
		});
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).toEqual([]);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'auto' }));
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests().length)).toBeGreaterThan(0);
		await page.evaluate(async () => {
			window.ashStandaloneIntegration.updateContributionOptions({ foldingStrategy: 'indentation' });
			const requests = window.ashStandaloneIntegration.readContributionRequests();
			for (let index = 0; index < requests.length; index++) await window.ashStandaloneIntegration.finishContributionRequest(index);
		});
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readContributionRequests())).every(request => request.aborted)).toBe(true);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareClipboard('first\n  child\nsecond\n  child\nthird\n  child'));
		const controls = page.locator('#caller .stanza-editor-line-decoration.ash-icon-folding-expanded');
		await expect(controls).toHaveCount(3);
		await controls.last().click();
		await expect(page.locator('#caller .view-line[data-logical-line-index="5"]')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ foldingMaximumRegions: 1 }));
		await expect(controls).toHaveCount(1);
		await expect(page.locator('#caller .view-line[data-logical-line-index="5"]')).toHaveCount(1);
		await page.evaluate(() => window.ashStandaloneIntegration.updateContributionOptions({ foldingMaximumRegions: 3 }));
		await expect(controls).toHaveCount(3);
		await page.evaluate(() => {
			window.ashStandaloneIntegration.prepareClipboard('first\n  inner\n    child\nsecond\n  child');
			window.ashStandaloneIntegration.updateContributionOptions({ foldingMaximumRegions: 2 });
		});
		await expect(controls).toHaveCount(2);
		await controls.last().click();
		await expect(page.locator('#caller .view-line[data-logical-line-index="4"]')).toHaveCount(0);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	for (const kind of ['hover', 'selection'] as const) {
		for (const reason of ['text', 'selection', 'language', 'provider', 'model', 'dispose', 'blur'] as const) {
			test(`${kind} provider request cancels on ${reason} and rejects late results`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
				if (kind === 'hover') {
					const point = await page.evaluate(() => window.ashStandaloneIntegration.languageHoverPoint());
					await page.mouse.move(point.x, point.y);
				} else {
					await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
				}
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([{ languageId: 'plaintext', aborted: false }]);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([{ languageId: 'plaintext', aborted: true }]);
				const before = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
				await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
				await expect(page.locator('.stanza-editor-hover:not([hidden])')).toHaveCount(0);
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(before);
				await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			});
		}
		test(`${kind} provider uses the current model language`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
			await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('language'));
			if (kind === 'hover') {
				const point = await page.evaluate(() => window.ashStandaloneIntegration.languageHoverPoint());
				await page.mouse.move(point.x, point.y);
			} else {
				await page.keyboard.press('ControlOrMeta+Shift+ArrowRight');
			}
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toEqual([{ languageId: 'typescript', aborted: false }]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			if (kind === 'hover') {
				await expect(page.locator('.stanza-editor-hover').first()).toHaveText('hover: typescript');
			} else {
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe('[1,1 -> 1,13]');
			}
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	for (const kind of ['definition', 'call', 'type', 'symbols'] as const) {
		const shortcut = { definition: 'F12', call: 'Alt+Shift+h', type: 'Alt+Shift+t', symbols: 'ControlOrMeta+Shift+o' }[kind];
		for (const reason of ['text', 'selection', 'language', 'provider', 'model', 'dispose', 'blur'] as const) {
			test(`${kind} provider cancels on ${reason} without applying late results`, async function () {
				const { page } = browserTests;

				await page.goto('/standalone.html');
				await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
				await page.keyboard.press(shortcut);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().slice(0, 1))).toEqual([{ languageId: 'plaintext', aborted: false }]);
				await page.evaluate(reason => window.ashStandaloneIntegration.changeLanguageRequest(reason), reason);
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().slice(0, 1))).toEqual([{ languageId: 'plaintext', aborted: true }]);
				if (reason === 'blur' && kind === 'symbols') {
					await expect(page.locator('#owned .stanza-editor-input')).toBeFocused();
				}
				const before = await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing());
				await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
				expect(await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toEqual(before);
				await expect(page.locator('#caller .stanza-editor-peek-view, #caller .ash-quick-pick')).toHaveCount(0);
				await page.evaluate(() => window.ashStandaloneIntegration.dispose());
			});
		}
		test(`${kind} provider queries the current language and applies the current response`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			await page.evaluate(kind => window.ashStandaloneIntegration.prepareLanguageRequest(kind), kind);
			await page.evaluate(() => window.ashStandaloneIntegration.changeLanguageRequest('language'));
			await page.keyboard.press(shortcut);
			await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests().slice(0, 1))).toEqual([{ languageId: 'typescript', aborted: false }]);
			await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
			if (kind === 'definition') {
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe('[1,7 -> 1,13]');
			} else if (kind === 'symbols') {
				await expect(page.locator('#caller .ash-quick-pick-row-label')).toHaveText('second');
			} else {
				await expect(page.locator('#caller .stanza-editor-language-hierarchy-item')).toHaveText('root');
				await page.locator('#caller .stanza-editor-language-hierarchy-expand').first().click();
				await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).toHaveLength(2);
				await page.keyboard.press('Escape');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageRequests())).every(request => request.aborted)).toBe(true);
				await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(1));
				await expect(page.locator('#caller .stanza-editor-peek-view')).toHaveCount(0);
			}
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test('symbol picker filters, navigates, restores focus and labels its input', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareLanguageRequest('symbols'));
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('ControlOrMeta+Shift+o');
		await page.evaluate(() => window.ashStandaloneIntegration.finishLanguageRequest(0));
		const picker = page.locator('#caller .ash-quick-pick');
		const query = picker.getByRole('combobox', { name: 'Go to Symbol' });
		await expect(picker).toHaveAttribute('aria-label', 'Go to Symbol');
		await query.fill('sec');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText('second');
		await page.keyboard.press('Enter');
		await expect(picker).toHaveCount(0);
		await expect(input).toBeFocused();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe('[1,7 -> 1,13]');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('symbol picker combines registered providers in document order', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareMultipleDocumentSymbols());
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+Shift+o');
		const picker = page.locator('#caller .ash-quick-pick');
		await expect(picker.locator('.ash-quick-pick-row-label')).toHaveText(['first', 'second']);
		await picker.getByRole('combobox', { name: 'Go to Symbol' }).fill('second');
		await page.keyboard.press('Enter');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).selection).toBe('[1,7 -> 1,13]');
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('document symbol command resolves a resource without changing the active editor', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareMultipleDocumentSymbols());
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readDocumentSymbolCommand())).toEqual(['first', 'second']);
		await expect(input).toBeFocused();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('signature trigger metadata distinguishes initial and repeated triggers and carries active hints', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(true, true, ['['], [':']));
		await page.keyboard.type('(:');
		await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
		await page.keyboard.type('[');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[0]!.context).toEqual({ kind: 'triggerCharacter', triggerCharacter: '[', isRetrigger: false });
		await page.evaluate(() => window.ashStandaloneIntegration.finishParameterHintRequest(0, 'hints'));
		await page.keyboard.type(':');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(2);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests()))[1]!.context).toMatchObject({ kind: 'triggerCharacter', triggerCharacter: ':', isRetrigger: true, activeSignatureHelp: { signatures: [{ label: 'call(value): plaintext' }] } });
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('signature providers without trigger metadata are invoked explicitly', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareParameterHints(true, true, []));
		await page.keyboard.type('(');
		await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 20)));
		expect(await page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests())).toEqual([]);
		await page.keyboard.press('ControlOrMeta+Shift+Space');
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readParameterHintRequests().length)).toBe(1);
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});


	for (const kind of ['rename', 'quickFix'] as const) {
		test(`${kind} public action uses its editor and tracks writable provider availability`, async function () {
			const { page } = browserTests;

			await page.goto('/standalone.html');
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageActions()))[kind]).toBe(false);
			await page.evaluate(kind => {
				if (kind === 'rename') window.ashStandaloneIntegration.prepareRenameRequests('prepare');
				else window.ashStandaloneIntegration.prepareCodeActionRequests('query');
				window.ashStandaloneIntegration.changeLanguageRequest('blur');
			}, kind);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageActions()))[kind]).toBe(true);
			await page.evaluate(kind => window.ashStandaloneIntegration.invokeLanguageAction(`editor.action.${kind}`), kind);
			await expect.poll(() => page.evaluate(kind => kind === 'rename'
				? window.ashStandaloneIntegration.readRenameRequests().length
				: window.ashStandaloneIntegration.readCodeActionRequests().length, kind)).toBe(1);
			if (kind === 'rename') {
				await page.evaluate(() => window.ashStandaloneIntegration.finishRenameRequest(0, 'edit'));
				await expect(page.locator('#caller .stanza-editor-rename-input')).toBeFocused();
				await page.evaluate(() => window.ashStandaloneIntegration.invokeLanguageAction('cancelRenameInput'));
				await expect(page.locator('#caller .stanza-editor-rename')).toBeHidden();
			} else {
				await page.evaluate(() => window.ashStandaloneIntegration.finishCodeActionRequest(0, 'edit'));
				await expect(page.locator('.ash-action-widget')).toBeVisible();
			}
			await page.evaluate(kind => {
				if (kind === 'rename') window.ashStandaloneIntegration.changeRenameState('readonly');
				else window.ashStandaloneIntegration.changeCodeActionState('readonly');
			}, kind);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.readLanguageActions()))[kind]).toBe(false);
			await page.evaluate(kind => window.ashStandaloneIntegration.invokeLanguageAction(`editor.action.${kind}`), kind);
			expect(await page.evaluate(kind => kind === 'rename'
				? window.ashStandaloneIntegration.readRenameRequests().length
				: window.ashStandaloneIntegration.readCodeActionRequests().length, kind)).toBe(1);
			await page.evaluate(() => window.ashStandaloneIntegration.dispose());
		});
	}

	test('editor scrollbar menu toggles the minimap', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		const minimap = page.locator('#caller .minimap');
		await expect(minimap).toBeVisible();
		await page.locator('#caller .ash-scrollbar-track-vertical').evaluate(track => {
			track.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 390, clientY: 20 }));
		});
		await page.getByRole('menuitemcheckbox', { name: 'Minimap' }).click();
		await expect(minimap).toBeHidden();
		await page.locator('#caller .ash-scrollbar-track-vertical').evaluate(track => {
			track.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 390, clientY: 20 }));
		});
		await expect(page.getByRole('menuitem', { name: 'Vertical Size' })).toBeDisabled();
		await page.evaluate(() => window.ashStandaloneIntegration.dispose());
	});

	test('code action filtering removes empty groups and keyboard navigation skips their labels', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions('grouped'));
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+.');
		const root = page.locator('.ash-action-widget');
		await expect(root.locator('.ash-action-widget-header')).toHaveText(['Quick Fix', 'Refactor']);
		await expect(root.getByRole('menuitem', { name: 'First action', exact: true })).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await expect(root.getByRole('menuitem', { name: 'Last action', exact: true })).toBeFocused();
		await page.keyboard.press('ControlOrMeta+f');
		const filter = root.getByRole('searchbox', { name: 'Filter actions' });
		await expect(filter).toBeFocused();
		await filter.fill('REFACTOR last');
		await expect(root.locator('.ash-action-widget-header')).toHaveText(['Refactor']);
		await expect(root.getByRole('menuitem')).toHaveCount(1);
		await filter.fill('missing');
		await expect(root.getByRole('menuitem')).toHaveCount(0);
		await expect(root.locator('.ash-action-widget-header')).toHaveCount(0);
		await expect(root.getByRole('status')).toHaveText('No matching actions.');
		await filter.fill('last');
		await page.keyboard.press('ArrowDown');
		await expect(root.getByRole('menuitem', { name: 'Last action', exact: true })).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(root).toHaveCount(0);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('last');
	});

	test('code action group labels and filter feedback use the Chinese catalog', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.setActionMenuLanguage('zh-CN');
			window.ashStandaloneIntegration.enableCodeActions('grouped');
		});
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+.');
		const root = page.locator('.ash-action-widget');
		await expect(root.locator('.ash-action-widget-header')).toHaveText(['快速修复', '重构']);
		await expect(root.getByRole('tablist', { name: '操作类别' })).toBeVisible();
		await expect(root.getByRole('tab', { name: '全部操作' })).toHaveAttribute('aria-selected', 'true');
		await root.getByRole('searchbox', { name: '筛选操作' }).fill('重构 last');
		await expect(root.locator('.ash-action-widget-header')).toHaveText(['重构']);
		await expect(root.getByRole('status')).toHaveText('找到 1 个操作。');
		await root.getByRole('searchbox', { name: '筛选操作' }).fill('missing');
		await expect(root.getByRole('status')).toHaveText('没有匹配的操作。');
		await page.keyboard.press('Escape');
		await expect(page.locator('#caller .stanza-editor-input')).toBeFocused();
	});

	for (const outcome of ['accept', 'cancel', 'change'] as const) {
		test(`code action preview ${outcome} uses the bulk edit pane and keeps the document unchanged until approval`, async function () {
			const { page } = browserTests;

			const errors: string[] = [];
			page.on('pageerror', error => errors.push(error.message));
			await page.goto('/standalone.html');
			if (outcome === 'cancel') {
				await page.evaluate(() => window.ashStandaloneIntegration.setActionMenuLanguage('zh-CN'));
			}
			await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionPreview());
			await page.locator('#action-preview-editor .stanza-editor-input').focus();
			await page.keyboard.press('ControlOrMeta+.');
			const root = page.locator('.ash-action-widget');
			await expect(root.getByRole('menuitem', { name: 'Replace value with result' })).toBeFocused();
			await expect(root.getByRole('button', { name: outcome === 'cancel' ? '预览' : 'Preview', exact: true })).toBeEnabled();
			if (outcome === 'accept') await root.getByRole('button', { name: 'Preview', exact: true }).click();
			else await page.keyboard.press('ControlOrMeta+Enter');
			const pane = page.locator('#action-preview-pane');
			const apply = pane.getByRole('button', { name: outcome === 'cancel' ? '应用所选修改' : 'Apply selected' });
			await expect(apply).toBeEnabled();
			await expect(root).toHaveCount(0);
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
			if (outcome === 'change') await page.evaluate(() => window.ashStandaloneIntegration.changeCodeActionState('text'));
			else await pane.getByRole('button', { name: outcome === 'accept' ? 'Apply selected' : '取消', exact: true }).click();
			await expect(apply).toBeDisabled();
			expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe(outcome === 'accept' ? 'result' : outcome === 'change' ? 'changed' : 'value');
			if (outcome === 'accept') {
				await page.locator('#action-preview-editor .stanza-editor-input').focus();
				await page.keyboard.press('ControlOrMeta+z');
				expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
			}
			expect(errors).toEqual([]);
		});
	}

	test('code action preview preserves partial selection, focus and expanded changes across grouping', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionPreview('multiple'));
		await page.locator('#action-preview-editor .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+.');
		await page.locator('.ash-action-widget').getByRole('button', { name: 'Preview', exact: true }).click();
		const pane = page.locator('#action-preview-pane');
		const replacements = pane.locator('.ash-bulk-edit-replacements input');
		await expect(replacements).toHaveCount(2);
		await pane.getByText('Show text change', { exact: true }).click();
		await replacements.nth(1).focus();
		await page.keyboard.press('Space');
		await expect(replacements.nth(1)).toBeFocused();
		await expect(replacements.nth(1)).not.toBeChecked();
		await expect(pane.locator('details')).toHaveAttribute('open', '');
		await expect(pane.locator('pre')).toHaveText('- value\n+ relue');
		await expect(replacements.nth(1)).toHaveAttribute('aria-description', /Alt\+F1/);
		const focusStyle = await replacements.nth(1).evaluate(element => {
			const style = getComputedStyle(element);
			return { outline: style.outlineStyle, width: style.outlineWidth };
		});
		expect(focusStyle.outline).toBe('solid');
		expect(parseFloat(focusStyle.width)).toBeGreaterThan(0);
		for (const theme of ['vs-dark', 'hc-black', 'hc-light']) {
			await page.evaluate(theme => window.ashStandaloneIntegration.setActionMenuTheme(theme), theme);
			const style = await pane.locator('.ash-bulk-edit-entry').evaluate(element => {
				const computed = getComputedStyle(element);
				return { border: computed.borderStyle, width: computed.borderWidth, color: computed.borderColor, contrast: computed.getPropertyValue('--ash-contrastBorder') };
			});
			expect(style.border).toBe('solid');
			expect(parseFloat(style.width)).toBeGreaterThan(0);
			if (theme.startsWith('hc-')) expect(style.color).toBe(await pane.evaluate((element, contrast) => {
				const probe = document.createElement('span');
				probe.style.color = contrast;
				element.append(probe);
				const color = getComputedStyle(probe).color;
				probe.remove();
				return color;
			}, style.contrast));
		}
		await pane.getByRole('button', { name: 'Group by type' }).click();
		await expect(pane.locator('.ash-bulk-edit-group-label')).toHaveText('Text changes');
		await expect(replacements.nth(1)).not.toBeChecked();
		await expect(pane.locator('details')).toHaveAttribute('open', '');
		await pane.getByRole('button', { name: 'Group by file' }).click();
		await expect(replacements.nth(1)).not.toBeChecked();
		await expect(pane.locator('details')).toHaveAttribute('open', '');
		await replacements.nth(0).focus();
		await page.keyboard.press('ControlOrMeta+Enter');
		await expect(pane.getByRole('button', { name: 'Apply selected' })).toBeDisabled();
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('relue');
		await page.locator('#action-preview-editor .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+z');
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
	});

	test('code action preview opens selected replacements in the read-only MultiDiff editor without applying them', async function () {
		const { page } = browserTests;

		const errors: string[] = [];
		page.on('pageerror', error => errors.push(error.message));
		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareCodeActionPreview('multiple'));
		await page.locator('#action-preview-editor .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+.');
		await page.locator('.ash-action-widget').getByRole('button', { name: 'Preview', exact: true }).click();
		const pane = page.locator('#action-preview-pane');
		await pane.locator('.ash-bulk-edit-replacements input').nth(1).uncheck();
		await pane.locator('.ash-bulk-edit-toolbar').getByRole('button', { name: 'Open changes' }).click();
		const diff = page.locator('#action-preview-diff');
		await expect(diff.locator('.view-lines')).toContainText(['value', 'relue']);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('value');
		await pane.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(pane.getByRole('button', { name: 'Apply selected' })).toBeDisabled();
		await expect(diff.locator('.view-lines')).toContainText(['value', 'relue']);
		expect(errors).toEqual([]);
	});

	test('code action category tabs preserve the query, skip labels and dispatch the original action', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCodeActions('grouped'));
		await page.locator('#caller .stanza-editor-input').focus();
		await page.keyboard.press('ControlOrMeta+.');
		const root = page.locator('.ash-action-widget');
		const all = root.getByRole('tab', { name: 'All actions' });
		await expect(all).toHaveAttribute('aria-selected', 'true');
		await all.focus();
		await page.keyboard.press('ArrowRight');
		const quickFix = root.getByRole('tab', { name: 'Quick Fix', exact: true });
		await expect(quickFix).toBeFocused();
		await expect(all).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Enter');
		await expect(quickFix).toHaveAttribute('aria-selected', 'true');
		await expect(root.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', await quickFix.getAttribute('id') as string);
		await expect(root.locator('.ash-action-widget-header')).toHaveCount(0);
		await page.keyboard.press('ArrowDown');
		await expect(root.getByRole('menuitem', { name: 'First action', exact: true })).toBeFocused();
		await page.keyboard.press('ControlOrMeta+f');
		const filter = root.getByRole('searchbox', { name: 'Filter actions' });
		await filter.fill('last');
		await expect(root.getByRole('status')).toHaveText('No matching actions.');
		await root.getByRole('tab', { name: 'Refactor', exact: true }).click();
		await expect(filter).toHaveValue('last');
		await expect(root.getByRole('menuitem')).toHaveCount(1);
		await root.getByRole('tab', { name: 'Refactor', exact: true }).focus();
		await page.keyboard.press('Alt+F1');
		const help = page.getByRole('dialog', { name: 'Action menu accessibility help' });
		await expect(help).toContainText('Left and Right Arrow');
		await page.keyboard.press('Escape');
		await expect(root.getByRole('tab', { name: 'Refactor', exact: true })).toBeFocused();
		await page.keyboard.press('ArrowDown');
		await page.keyboard.press('Enter');
		await expect(root).toHaveCount(0);
		expect((await page.evaluate(() => window.ashStandaloneIntegration.state('caller'))).value).toBe('last');
	});

	test('symbol highlight backgrounds align with their text in the isolated editor', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		const editor = new Editor(page.locator('#caller'));
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		await editor.waitForEditorFocus();
		await editor.waitForTypeInEditor('use crate::UserAllowlist;');
		await page.keyboard.press('Enter');
		await editor.waitForTypeInEditor('    user_allowlist: UserAllowlist,');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowLeft');
		await expect(editor.element.locator('.cdr.word-highlight-text')).toHaveCount(2);
		await expect.poll(() => editor.element.evaluate(root => {
			return [...root.querySelectorAll<HTMLElement>('.cdr.word-highlight-text')].map(highlight => {
				const lineIndex = highlight.parentElement!.dataset.lineIndex;
				const text = root.querySelector(`.view-lines > .view-line[data-line-index="${lineIndex}"] > .stanza-editor-line-text`)!;
				const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
				let symbol: DOMRect | undefined;
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					const start = node.textContent!.indexOf('UserAllowlist');
					if (start < 0) continue;
					const range = document.createRange();
					range.setStart(node, start);
					range.setEnd(node, start + 'UserAllowlist'.length);
					symbol = range.getBoundingClientRect();
					break;
				}
				const background = highlight.getBoundingClientRect();
				return { lineIndex, aligned: symbol !== undefined && Math.abs(background.left - symbol.left) < 1 && Math.abs(background.right - symbol.right) < 1 };
			});
		})).toEqual([{ lineIndex: '0', aligned: true }, { lineIndex: '1', aligned: true }]);
	});

	test('minimap reflects equal-length text edits in the isolated editor', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('iiii\n\n \t \niiii');
		await expect(editor.lines).toHaveText(['iiii', '', ' \t ', 'iiii']);
		const canvas = editor.element.locator('.minimap canvas');
		const minimap = editor.element.locator('.minimap');
		await expect(minimap).toHaveCSS('overflow', 'hidden');
		await expect(minimap).toHaveCSS('background-color', await editor.element.evaluate(element => getComputedStyle(element).backgroundColor));
		const readPixels = () => canvas.evaluate(element => {
			const canvas = element as HTMLCanvasElement;
			return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data);
		});
		await expect.poll(async () => (await readPixels()).some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
		const original = await readPixels();
		await page.keyboard.press('ControlOrMeta+Home');
		for (let index = 0; index < 4; index++) {
			await page.keyboard.press('Shift+ArrowRight');
		}
		await page.keyboard.insertText('WWWW');
		await expect(editor.lines.first()).toHaveText('WWWW');
		await expect.poll(readPixels).not.toEqual(original);
		await expect(editor.element.locator('.minimap')).toHaveAttribute('aria-hidden', 'true');
	});

	test('minimap shadow indicates content beyond the right edge', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		const minimap = editor.element.locator('.minimap');
		const scrollable = editor.element.locator(':scope > .ash-smooth-scrollable');
		const readShadow = () => minimap.evaluate(element => {
			const style = getComputedStyle(element, '::after');
			return { content: style.content, shadow: style.boxShadow, pointerEvents: style.pointerEvents, left: style.left };
		});
		await page.keyboard.insertText('short line');
		await expect.poll(async () => (await readShadow()).shadow).toBe('none');
		await page.keyboard.insertText(' long text'.repeat(100));
		await scrollable.evaluate(element => { element.scrollLeft = 0; });
		await expect.poll(() => scrollable.evaluate(element => element.scrollWidth > element.clientWidth && element.scrollLeft === 0)).toBe(true);
		await expect.poll(async () => (await readShadow()).shadow).not.toBe('none');
		expect(await readShadow()).toMatchObject({ content: '""', pointerEvents: 'none', left: '-6px' });
		await minimap.evaluate(element => element.style.setProperty('--ash-minimap-shadow', '#123456'));
		try {
			await expect.poll(async () => (await readShadow()).shadow).toBe('rgb(18, 52, 86) 0px 0px 6px 0px');
		} finally {
			await minimap.evaluate(element => element.style.removeProperty('--ash-minimap-shadow'));
		}
		await page.emulateMedia({ forcedColors: 'active' });
		await expect.poll(async () => (await readShadow()).shadow).toBe('none');
		await page.emulateMedia({ forcedColors: 'none' });
		await expect.poll(async () => (await readShadow()).shadow).not.toBe('none');
		await scrollable.evaluate(element => { element.scrollLeft = element.scrollWidth; });
		await expect.poll(() => scrollable.evaluate(element => element.scrollLeft + element.clientWidth >= element.scrollWidth)).toBe(true);
		await expect.poll(async () => (await readShadow()).shadow).toBe('none');
		await scrollable.evaluate(element => { element.scrollLeft = 0; });
		await expect.poll(async () => (await readShadow()).shadow).not.toBe('none');
	});

	test('clicking inside editor text places insertion at the clicked character', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		await page.locator('#caller').evaluate(element => { element.style.height = '400px'; });
		await page.evaluate(() => window.ashStandaloneIntegration.layoutContribution(640, 400));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		const text = 'mode switcher > radiogroup';
		await page.keyboard.insertText(`${'context\n'.repeat(9)}${text}\n${'wide '.repeat(100)}`);
		await page.keyboard.press('ControlOrMeta+Home');
		const line = editor.lines.nth(9);
		await expect(line).toHaveText(text);
		for (const offset of [text.length, 20, 16]) {
			const point = await line.evaluate((element, offset) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let remaining = offset;
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					const length = node.textContent!.length;
					if (remaining <= length) {
						const range = document.createRange();
						range.setStart(node, remaining);
						range.collapse(true);
						const rect = range.getBoundingClientRect();
						return { x: rect.left - 1, y: rect.top + rect.height / 2 };
					}
					remaining -= length;
				}
				throw new Error(`Missing rendered offset ${offset}`);
			}, offset);
			await page.mouse.move(point.x, point.y);
			await page.mouse.down();
			await page.mouse.move(point.x - 0.5, point.y + 0.25);
			await page.mouse.up();
			await page.keyboard.insertText('!');
			await expect(line).toHaveText(`${text.slice(0, offset)}!${text.slice(offset)}`);
			await page.keyboard.press('Backspace');
			await expect(editor.input).toBeFocused();
			await expect.poll(async () => {
				const caret = await editor.element.locator('.stanza-editor-caret.primary').boundingBox();
				return caret ? Math.abs(caret.x - point.x) : Number.POSITIVE_INFINITY;
			}).toBeLessThan(3);
			await expect(line).toHaveText(text);
		}
	});

	test('dragging editor text after horizontal scrolling replaces the selected characters', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		const text = 'mode switcher > radiogroup';
		await page.keyboard.insertText(`${'wide '.repeat(100)}\n${text}`);
		const line = editor.lines.nth(1);
		await expect(line).toHaveText(text);
		await line.hover();
		const before = (await line.boundingBox())!.x;
		await page.mouse.wheel(60, 0);
		await expect.poll(async () => (await line.boundingBox())!.x).toBeLessThan(before - 40);
		const points = await line.evaluate(element => [16, 26].map(offset => {
			const node = element.firstChild!.firstChild!;
			const range = document.createRange();
			range.setStart(node, offset);
			range.collapse(true);
			const bounds = range.getBoundingClientRect();
			const row = element.closest('.view-line')!.getBoundingClientRect();
			return { x: bounds.left - 0.25, y: bounds.top + bounds.height / 2, top: row.top, height: row.height };
		}));
		await page.mouse.move(points[0]!.x, points[0]!.y);
		await page.mouse.down();
		await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 8 });
		await page.mouse.up();
		await expect.poll(async () => {
			const selection = await editor.element.locator('.stanza-editor-selection').boundingBox();
			const caret = await editor.element.locator('.stanza-editor-caret.primary').boundingBox();
			if (!selection || !caret) return Number.POSITIVE_INFINITY;
			return Math.max(
				Math.abs(selection.x - points[0]!.x),
				Math.abs(selection.width - (points[1]!.x - points[0]!.x)),
				Math.abs(selection.y - points[0]!.top),
				Math.abs(selection.height - points[0]!.height),
				Math.abs(caret.x - points[1]!.x),
				Math.abs(caret.y - points[1]!.top),
			);
		}).toBeLessThan(2);
		await expect.poll(() => editor.element.locator('.stanza-editor-selection').evaluate(element => {
			const rect = element.getBoundingClientRect();
			const pointerEvents = (element as HTMLElement).style.pointerEvents;
			// Test browser paint order even though the selection background ignores pointer input.
			(element as HTMLElement).style.pointerEvents = 'auto';
			try {
				const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
				const textIndex = stack.findIndex(node => node.closest('.view-lines'));
				return textIndex >= 0 && stack.indexOf(element) > textIndex;
			} finally {
				(element as HTMLElement).style.pointerEvents = pointerEvents;
			}
		})).toBe(true);
		await page.keyboard.insertText('!');
		await expect(line).toHaveText('mode switcher > !');
	});

	test('Chinese drag selection does not jump when pointer capture starts or ends', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		const text = '是否带个电饭锅电饭锅的方法蛋糕';
		await page.keyboard.insertText(text);
		await expect(editor.lines.first()).toHaveText(text);
		const point = await editor.lines.first().evaluate(element => {
			const node = element.firstChild!.firstChild!;
			const range = document.createRange();
			range.setStart(node, 0);
			range.setEnd(node, 1);
			const rect = range.getBoundingClientRect();
			return { x: rect.left + rect.width / 2 + 0.25, y: rect.top + rect.height / 2, width: rect.width, left: rect.left };
		});
		await page.mouse.move(point.x, point.y);
		await page.mouse.down();
		const caret = editor.element.locator('.stanza-editor-caret.primary');
		await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
		const anchor = await caret.boundingBox();
		expect(anchor).not.toBeNull();
		const anchorOffset = Math.abs(anchor!.x - point.left) < 1 ? 0 : 1;
		try {
			for (const distance of [0, point.width, 0]) {
				await page.mouse.move(point.x + distance, point.y + 0.05);
				await expect(editor.element.locator('.stanza-editor-selection')).toHaveCount(distance === 0 ? 0 : 1);
				await expect.poll(async () => (await caret.boundingBox())!.x).toBeCloseTo(anchor!.x + distance, 0);
				await expect(editor.input).toBeFocused();
			}
		} finally {
			await page.mouse.up();
		}
		await expect(editor.element.locator('.stanza-editor-selection')).toHaveCount(0);
		await expect.poll(async () => (await caret.boundingBox())!.x).toBe(anchor!.x);
		await page.keyboard.insertText('!');
		await expect(editor.lines.first()).toHaveText(`${text.slice(0, anchorOffset)}!${text.slice(anchorOffset)}`);
	});

	test('editor scrollbar track background follows the theme through hover and dragging', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html?workbenchStyles');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText(Array.from({ length: 120 }, () => 'long text '.repeat(100)).join('\n'));
		await page.keyboard.press('ControlOrMeta+Home');
		const tracks = editor.element.locator('.ash-scrollbar-track');
		await expect(tracks).toHaveCount(2);
		for (const track of await tracks.all()) {
			await expect(track).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		}
		await editor.element.evaluate(element => element.style.setProperty('--ash-scrollbar-background', '#123456'));
		try {
			for (const track of await tracks.all()) {
				await expect(track).toHaveCSS('background-color', 'rgb(18, 52, 86)');
				await expect(track).toHaveCSS('border-radius', '0px');
			}
			const vertical = editor.element.locator('.ash-scrollbar-track-vertical');
			await vertical.hover();
			await expect(vertical).toHaveCSS('background-color', 'rgb(18, 52, 86)');
			const thumb = (await vertical.locator('.ash-scrollbar-thumb').boundingBox())!;
			await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
			await page.mouse.down();
			try {
				await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2 + 20);
				await expect(vertical).toHaveClass(/\bactive\b/u);
				await expect(vertical).toHaveCSS('background-color', 'rgb(18, 52, 86)');
				await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			} finally {
				await page.mouse.up();
			}
		} finally {
			await editor.element.evaluate(element => element.style.removeProperty('--ash-scrollbar-background'));
		}
		for (const track of await tracks.all()) {
			await expect(track).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
		}
	});

	test('minimap slider has modern corners and reaches the scrollbar bottom', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html?workbenchStyles');
		await page.waitForFunction(() => !!window.ashStandaloneIntegration);
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText(Array.from({ length: 1_200 }, () => 'long text '.repeat(100)).join('\n'));
		const minimap = editor.element.locator('.minimap');
		const slider = minimap.locator('.stanza-editor-minimap-slider');
		const thumb = editor.element.locator('.ash-scrollbar-track-vertical .ash-scrollbar-thumb');
		await expect(page.locator('body')).toHaveClass(/\bmodern-ui\b/u);
		await expect(slider).toHaveCSS('border-radius', '4px');
		await page.keyboard.press('ControlOrMeta+Home');
		await expect.poll(async () => (await slider.boundingBox())!.y - (await thumb.boundingBox())!.y).toBeCloseTo(0, 1);
		await page.keyboard.press('ControlOrMeta+End');
		await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop > 0 && element.scrollTop === element.scrollHeight - element.clientHeight)).toBe(true);
		await expect.poll(async () => {
			const map = (await slider.boundingBox())!;
			const bar = (await thumb.boundingBox())!;
			return map.y + map.height - bar.y - bar.height;
		}).toBeCloseTo(0, 1);
		await minimap.hover();
		await expect(slider).toHaveCSS('opacity', '1');
		const box = (await slider.boundingBox())!;
		const root = (await minimap.boundingBox())!;
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await page.mouse.down();
		await page.mouse.move(box.x + box.width / 2, root.y - box.height);
		await page.mouse.up();
		await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBe(0);
		await expect(editor.element.locator('.stanza-editor-input')).toBeFocused();
	});

	test('editor Enter preserves indentation and undo restores the input position', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('  value');
		await editor.input.press('Enter');
		await expect(editor.lines).toHaveText(['  value', '  ']);
		await expect(editor.input).toBeFocused();
		await editor.input.press('ControlOrMeta+z');
		await expect(editor.lines).toHaveText(['  value']);
		await page.keyboard.insertText('!');
		await expect(editor.lines).toHaveText(['  value!']);
		await expect(editor.input).toBeFocused();
	});

	test('editor preserves space and tab indentation and places input at the rendered text', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		const lines = ['plain', '    spaces', '\ttab', ' \t mixed  text ', '\t\tnested'];
		await page.keyboard.insertText(lines.join('\n'));
		await expect.poll(() => editor.lines.allTextContents()).toEqual(lines);
		const measurements = await editor.lines.evaluateAll(elements => {
			return elements.map(element => {
				const text = element.textContent!;
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				const nodes: Text[] = [];
				for (let node = walker.nextNode(); node; node = walker.nextNode()) {
					nodes.push(node as Text);
				}
				const boundsAt = (offset: number) => {
					let remaining = offset;
					for (const node of nodes) {
						if (remaining <= node.length) {
							const range = document.createRange();
							range.setStart(node, remaining);
							range.collapse(true);
							return range.getBoundingClientRect();
						}
						remaining -= node.length;
					}
					throw new Error(`Missing rendered offset ${offset}`);
				};
				const start = boundsAt(0);
				const content = boundsAt(text.search(/\S/u));
				const last = boundsAt(text.length - 1);
				const end = boundsAt(text.length);
				return {
					indent: content.left - start.left,
					width: end.left - start.left,
					lastWidth: end.left - last.left,
					x: content.left + 0.25,
					y: content.top + content.height / 2,
					tabSize: Number(getComputedStyle(element).tabSize),
				};
			});
		});
		const characterWidth = measurements[0]!.lastWidth;
		const tabSize = measurements[0]!.tabSize;
		const columns = [5, 10, tabSize + 3, tabSize + 13, tabSize * 2 + 6];
		const indentation = [0, 4, tabSize, tabSize + 1, tabSize * 2];
		for (let index = 0; index < lines.length; index++) {
			expect(Math.abs(measurements[index]!.indent - indentation[index]! * characterWidth)).toBeLessThan(1);
			expect(Math.abs(measurements[index]!.width - columns[index]! * characterWidth)).toBeLessThan(1);
		}
		const point = measurements[4]!;
		await page.mouse.click(point.x, point.y);
		await expect.poll(() => editor.element.locator('.stanza-editor-caret.primary').evaluate((element, point) => {
			const bounds = element.getBoundingClientRect();
			return Math.abs(bounds.left + parseFloat(getComputedStyle(element).paddingLeft) - point.x);
		}, point)).toBeLessThan(1);
		await page.keyboard.insertText('!');
		await expect.poll(() => editor.lines.allTextContents()).toEqual([...lines.slice(0, 4), '\t\t!nested']);
		await editor.input.press('ControlOrMeta+z');
		await expect.poll(() => editor.lines.allTextContents()).toEqual(lines);
		await expect(editor.input).toBeFocused();
	});

	test('line numbers stay aligned while scrolling and gutter clicks edit the visible line', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText(Array.from({ length: 160 }, (_, index) => `line-${index + 1} ${'text '.repeat(40)}`).join('\n'));
		await editor.input.press('ControlOrMeta+Home');
		const scrollContainer = editor.element.locator(':scope > .ash-smooth-scrollable');
		await expect.poll(() => scrollContainer.evaluate(element => element.scrollTop)).toBe(0);
		await editor.element.hover();
		await page.mouse.wheel(0, 600);
		await expect.poll(() => scrollContainer.evaluate(element => element.scrollTop)).toBe(600);
		await expect.poll(() => editor.element.evaluate(root => {
			const bounds = root.getBoundingClientRect();
			const rows = [...root.querySelectorAll<HTMLElement>('.view-lines > .view-line')]
				.filter(row => row.getBoundingClientRect().top >= bounds.top && row.getBoundingClientRect().bottom <= bounds.bottom);
			return {
				hasVisibleLines: rows.length > 0,
				aligned: rows.every(row => {
					const number = root.querySelector<HTMLElement>(`.margin-view-overlays > .view-overlay-line[data-line-index="${row.dataset.lineIndex}"]`)!;
					return number.querySelector('.line-numbers')!.textContent === String(Number(row.dataset.lineIndex) + 1)
						&& number.getBoundingClientRect().top === row.getBoundingClientRect().top;
				}),
				scrollTop: root.scrollTop,
			};
		})).toEqual({ hasVisibleLines: true, aligned: true, scrollTop: 0 });
		const lineIndex = await editor.element.evaluate(root => {
			const bounds = root.getBoundingClientRect();
			return [...root.querySelectorAll<HTMLElement>('.view-lines > .view-line')]
				.find(row => row.getBoundingClientRect().top >= bounds.top)!.dataset.lineIndex!;
		});
		// Gutter overlays ignore pointer events; the editor resolves the clicked
		// position through its hit-test controller rather than a number element handler.
		const numberBounds = (await editor.element.locator(`.margin-view-overlays > .view-overlay-line[data-line-index="${lineIndex}"] .line-numbers`).boundingBox())!;
		await page.mouse.click(numberBounds.x + numberBounds.width / 2, numberBounds.y + numberBounds.height / 2);
		// Line-number clicks select the complete source line. Collapse that selection
		// to its start before editing, and verify the selected row independently.
		const clickedLine = Number(lineIndex) + 1;
		await expect.poll(() => page.evaluate(() => window.ashStandaloneIntegration.readKeyboardEditing())).toMatchObject({
			selection: `[${clickedLine},1 -> ${clickedLine + 1},1]`, focused: true,
		});
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('Home');
		await page.keyboard.insertText('!');
		await expect(editor.element.locator(`.view-lines > .view-line[data-line-index="${lineIndex}"] .stanza-editor-line-text`))
			.toHaveText(`!line-${Number(lineIndex) + 1} ${'text '.repeat(40)}`);
		await expect(editor.input).toBeFocused();
	});

	test('multiline text input is restored by one undo in the editor', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('one\ntwo\nthree');
		await editor.waitForEditorContents(contents => contents === 'one\ntwo\nthree');
		await editor.input.press('ControlOrMeta+z');
		await expect(editor.lines).toHaveText(['']);
		await editor.input.press('ControlOrMeta+Shift+z');
		await expect(editor.lines).toHaveText(['one', 'two', 'three']);
		await expect(editor.input).toBeFocused();
	});

	test('browser range replacement restores its text and selection through undo and redo', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.prepareGuides(''));
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText('hello\nworld');
		await editor.input.press('ControlOrMeta+Home');
		await editor.input.press('End');
		await editor.input.evaluate(element => {
			const context = (element as HTMLElement & { editContext?: EventTarget; }).editContext;
			if (!context) throw new Error('Browser EditContext is unavailable');
			context.dispatchEvent(Object.assign(new Event('textupdate'), {
				text: 'hi', updateRangeStart: 0, updateRangeEnd: 5, selectionStart: 0, selectionEnd: 2,
			}));
		});
		await expect(editor.lines).toHaveText(['hi', 'world']);
		await page.keyboard.insertText('!');
		await expect(editor.lines).toHaveText(['!', 'world']);
		await editor.input.press('ControlOrMeta+z');
		await expect(editor.lines).toHaveText(['hi', 'world']);
		await editor.input.press('ControlOrMeta+z');
		await expect(editor.lines).toHaveText(['hello', 'world']);
		await editor.input.press('ControlOrMeta+Shift+z');
		await expect(editor.lines).toHaveText(['hi', 'world']);
		await page.keyboard.insertText('!');
		await expect(editor.lines).toHaveText(['!', 'world']);
		await expect(editor.input).toBeFocused();
	});

	test('built-in themes apply scrollbar and minimap colors through hover and dragging', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => {
			window.ashStandaloneIntegration.registerBundledThemes();
			window.ashStandaloneIntegration.prepareGuides('');
		});
		const editor = new Editor(page.locator('#caller'));
		await editor.waitForEditorFocus();
		await page.keyboard.insertText(Array.from({ length: 120 }, () => 'long text '.repeat(100)).join('\n'));
		await page.keyboard.press('ControlOrMeta+Home');
		const vertical = editor.element.locator('.ash-scrollbar-track-vertical');
		const thumb = vertical.locator('.ash-scrollbar-thumb');
		const minimap = editor.element.locator('.minimap');
		const slider = minimap.locator('.stanza-editor-minimap-slider');
		for (const { id, colors, shadow } of [
			{
				id: 'ash-dark',
				colors: ['rgba(168, 169, 170, 0.52)', 'rgba(168, 169, 170, 0.56)', 'rgba(168, 169, 170, 0.61)'],
				shadow: 'rgba(0, 0, 0, 0.08) 0px 0px 6px 0px',
			},
			{
				id: 'ash-light',
				colors: ['rgba(100, 100, 100, 0.25)', 'rgba(100, 100, 100, 0.4)', 'rgba(100, 100, 100, 0.5)'],
				shadow: 'rgba(0, 0, 0, 0.08) 0px 0px 6px 0px',
			},
			{
				id: 'ash-high-contrast-dark',
				colors: ['rgb(255, 255, 255)', 'rgb(255, 255, 255)', 'rgb(255, 255, 0)'], shadow: 'none',
			},
			{
				id: 'ash-high-contrast-light',
				colors: ['rgb(0, 0, 0)', 'rgb(0, 0, 0)', 'rgb(0, 0, 238)'], shadow: 'none',
			},
		] as const) {
			const [background, hover, active] = colors;
			await page.evaluate(theme => window.ashStandaloneIntegration.setActionMenuTheme(theme), id);
			await expect(page.locator('html')).toHaveAttribute('data-color-theme', id);
			await page.mouse.move(0, 0);
			await expect(thumb).toHaveCSS('background-color', background);
			await expect(slider).toHaveCSS('background-color', background);
			await expect(vertical).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
			await expect.poll(() => editor.element.locator('canvas.decorationsOverviewRuler').evaluate((element: HTMLCanvasElement) => {
				const pixels = element.getContext('2d')!.getImageData(2, Math.floor(element.height / 2), 1, 1).data;
				const probe = document.createElement('canvas').getContext('2d')!;
				probe.fillStyle = getComputedStyle(element.closest('.stanza-editor')!).backgroundColor;
				probe.fillRect(0, 0, 1, 1);
				return Array.from(pixels).join(',') === Array.from(probe.getImageData(0, 0, 1, 1).data).join(',');
			})).toBe(true);
			await expect.poll(() => minimap.evaluate(element => getComputedStyle(element, '::after').boxShadow)).toBe(shadow);
			await minimap.hover();
			await expect(slider).toHaveCSS('background-color', hover);
			await vertical.hover();
			await expect(thumb).toHaveCSS('background-color', hover);
			const bounds = (await thumb.boundingBox())!;
			await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
			await page.mouse.down();
			try {
				await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 20);
				await expect(thumb).toHaveCSS('background-color', active);
				await expect.poll(() => editor.element.locator(':scope > .ash-smooth-scrollable').evaluate(element => element.scrollTop)).toBeGreaterThan(0);
			} finally {
				await page.mouse.up();
			}
			await editor.input.press('ControlOrMeta+Home');
		}

		const colors = await slider.evaluate(element => {
			const minimap = element.parentElement!;
			const initial = getComputedStyle(element).backgroundColor;
			minimap.style.setProperty('--ash-minimapSlider-background', '#123456');
			const overridden = getComputedStyle(element).backgroundColor;
			minimap.style.removeProperty('--ash-minimapSlider-background');
			return { initial, overridden, restored: getComputedStyle(element).backgroundColor };
		});
		expect(colors.initial).not.toBe('rgba(0, 0, 0, 0)');
		expect(colors.overridden).toBe('rgb(18, 52, 86)');
		expect(colors.restored).toBe(colors.initial);
	});


	test('nested completion snippets retain inner mirrors and outer Tab and Shift Tab navigation', async function () {
		const { page } = browserTests;

		await page.goto('/standalone.html');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation('${1:outer} ${2:tail} $0'));
		const input = page.locator('#caller .stanza-editor-input');
		await input.focus();
		await page.keyboard.press('Control+Space');
		await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
		await page.keyboard.press('Enter');
		await page.keyboard.press('ArrowRight');
		await page.evaluate(() => window.ashStandaloneIntegration.enableCompletionNavigation('(${1:inner}+$1)-${2:end}', false));
		await page.keyboard.press('Control+Space');
		await expect(page.locator('#caller .stanza-editor-completion-option')).toHaveCount(2);
		await page.keyboard.press('Enter');
		await page.keyboard.type('X');
		const line = page.locator('#caller .view-line').first();
		await expect(line).toHaveText('conouter(X+X)-end tail ');
		await page.keyboard.press('Tab');
		await page.keyboard.type('Y');
		await page.keyboard.press('Tab');
		await page.keyboard.press('Tab');
		await page.keyboard.type('Z');
		await expect(line).toHaveText('conouter(X+X)-Y Z ');
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.press('Shift+Tab');
		await page.keyboard.type('W');
		await expect(line).toHaveText('conouter(X+X)-W Z ');
	});
});
