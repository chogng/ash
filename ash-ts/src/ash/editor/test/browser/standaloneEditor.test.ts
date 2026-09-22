import { createLanguageFeatureRequest } from '../../common/languages.js';
import { Emitter } from '../../../base/common/event.js';
import { editorWorkerWireCodec, EditorWorker } from '../../common/services/editorWebWorker.js';
import { FormattingConflicts, FormattingKind, FormattingMode } from '../../contrib/format/browser/format.js';
import { type DocumentFormattingEditProvider, type OnTypeFormattingEditProvider } from '../../common/languages.js';
import { TextModel } from '../../common/model/textModel.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../base/common/uri.js";
import { CancellationTokenSource } from '../../../base/common/cancellation.js';
import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { lightColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { LanguageFeaturesService } from "../../common/services/languageFeaturesService.js";
import { EditorContributionInstantiation } from '../../browser/editorExtensions.js';
import { TestLanguageConfigurationService } from '../common/modes/testLanguageConfigurationService.js';
import { StandaloneServiceCollection, StandaloneServices } from "../../standalone/browser/standaloneServices.js";
import { WorkerTextModelSyncServer } from '../../common/services/textModelSync/textModelSync.impl.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
const forcedColors = new browserEnvironment.window.EventTarget();
Object.defineProperties(forcedColors, {
	matches: { configurable: true, value: false, writable: true },
	media: { configurable: true, value: "(forced-colors: active)" },
});
Object.defineProperty(browserEnvironment.window, "matchMedia", {
	configurable: true,
	value: (query: string) => {
		assert.equal(query, "(forced-colors: active)");
		return forcedColors;
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
		dispose() {},
		[Symbol.dispose]() {},
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
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	ResizeObserver: TestResizeObserver,
	Worker: TestWorker,
})) Object.defineProperty(globalThis, name, { configurable: true, value });

const stanza = await import("../../editor.main.js");

suiteTeardown(() => browserEnvironment.window.close());

test("standalone service collection honors explicit first-scope overrides", () => {
	const languageConfigurations = new TestLanguageConfigurationService();
	const languages = new LanguageFeaturesService();
	const services = new StandaloneServiceCollection({ languageConfigurationService: languageConfigurations, languageFeaturesService: languages });
	assert.equal(services.languageFeaturesService, languages);
	assert.equal(services.themeService.getColorTheme(), lightColorTheme);
	assert.ok(services.instantiationService.get(ILogService) instanceof NullLoggerService);
	services.dispose();
	assert.equal(languages.isDisposed, false);
	languages.dispose();
	languageConfigurations.dispose();
});

test('standalone services own and release their default formatter selection', async () => {
	using model = new TextModel('alpha');
	const first: DocumentFormattingEditProvider = { provideDocumentFormattingEdits: () => [] };
	const second: DocumentFormattingEditProvider = { provideDocumentFormattingEdits: () => [] };
	const providers = [first, second];
	using host = FormattingConflicts.setFormatterSelector(async choices => choices[1]);
	assert.strictEqual(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File), second);
	using services = new StandaloneServiceCollection({});
	assert.strictEqual(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File), first);
	services.dispose();
	assert.strictEqual(await FormattingConflicts.select(providers, model, FormattingMode.Explicit, FormattingKind.File), second);
});

test("standalone theme APIs register, select, and project a named theme", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	stanza.editor.defineNamedTheme("standalone-test", {
		label: "Standalone Test",
		colorScheme: stanza.ColorScheme.Dark,
		colors: { "editor.background": "#101010" },
	});
	const container = dom.window.document.querySelector<HTMLElement>("main")!;
	const editor = stanza.editor.create(container, { value: "theme", theme: "standalone-test" });
	assert.equal(container.getAttribute("data-color-theme"), "standalone-test");
	assert.equal(container.style.getPropertyValue("--ash-editor-background"), "#101010");

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
	const registry = StandaloneServices.get().languageFeaturesService.onTypeFormattingEditProvider;
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

test('standalone languages API replaces provider batches atomically', () => {
	const first = {
		provideHover: () => ({ contents: ['first'] }),
	};
	const second = {
		provideHover: () => ({ contents: ['second'] }),
	};
	using model = new stanza.TextModel('', { languageId: 'stanza-batch' });
	using batch = stanza.languages.registerProviderBatch({ hovers: [{ selector: 'stanza-batch', provider: first }] });
	const providers = StandaloneServices.get().languageFeaturesService.hoverProvider;

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
	const services = StandaloneServices.get();
	assert.equal(services.languageService.resolveLanguageId({ resource: URI.parse('file:///sample.stanza-public') }), 'stanza-public-test');
	assert.equal(services.languageConfigurationService.getLanguageConfiguration('stanza-public-test').comments?.lineCommentToken, '//');
	using model = stanza.editor.createModel('answer', 'stanza-public-test', URI.parse('inmemory://stanza/public-api.stanza-public'));
	assert.equal(model instanceof stanza.TextModel, true);
	if (!(model instanceof stanza.TextModel)) throw new Error('Expected the standalone model implementation');
	const signal = new AbortController().signal;
	assert.deepEqual(await services.languageFeaturesService.hoverProvider.ordered(model)[0]!.provideHover({ ...createLanguageFeatureRequest(model, model.getLanguageId(), signal), position: new stanza.Position(1, 2) }, signal), { contents: ['Public hover'] });
});

test("standalone completion providers execute in a live editor", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
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
	const editor = stanza.editor.create(container, { language: "stanza-completion-test" });

	editor.focus();
	container.querySelector<HTMLElement>(".stanza-editor-input")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		ctrlKey: true,
		key: " ",
	}));
	await new Promise<void>(resolve => setImmediate(resolve));
	await new Promise<void>(resolve => setImmediate(resolve));

	assert.equal(requests, 1);
	assert.equal(container.querySelector(".stanza-editor-completion-option")?.textContent, "TextstandaloneResult");
	editor.dispose();
	dom.window.close();
});

test("standalone API registers URI and language identity with model lifecycle events", () => {
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
	const dom = new JSDOM("<!doctype html><body><main></main><aside></aside></body>");
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

test('standalone creation event exposes an assembled editor and caller-owned model', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = dom.window.document.querySelector<HTMLElement>('main')!;
	const model = stanza.editor.createModel('caller text', 'plaintext', URI.parse('inmemory://stanza/event-ready.txt'));
	const observations: unknown[] = [];
	using listener = stanza.editor.onDidCreateEditor(editor => observations.push({
		model: editor.getModel(),
		registered: stanza.editor.getEditors().includes(editor),
		mounted: container.contains(editor.getDomNode()),
		placeholder: editor.getContribution('editor.contrib.placeholderText') !== null,
		theme: container.getAttribute('data-color-theme'),
	}));
	const editor = stanza.editor.create(container, { model, placeholder: 'Start typing' });

	assert.deepEqual(observations, [{
		model,
		registered: true,
		mounted: true,
		placeholder: true,
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
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
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
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
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
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
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
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
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
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
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
	const dom = new JSDOM('<!doctype html><body><main></main><aside></aside></body>');
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
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
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
