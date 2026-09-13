import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../base/common/uri.js";
import { lightColorTheme } from "../../../platform/theme/common/colorTheme.js";
import { ILogService, NullLoggerService } from '../../../platform/log/common/log.js';
import { LanguageFeaturesService } from "../../common/services/languageFeaturesService.js";
import { TestLanguageConfigurationService } from '../common/modes/testLanguageConfigurationService.js';
import { LanguageHoverService } from '../../contrib/hover/common/hover.js';
import { StandaloneServiceCollection, StandaloneServices } from "../../standalone/browser/standaloneServices.js";

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
	constructor() {
		super();
		createdWorkerCount += 1;
	}
	postMessage(): void {}
	terminate(): void { terminatedWorkerCount += 1; }
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
	const languages = new LanguageFeaturesService(languageConfigurations);
	const services = new StandaloneServiceCollection({ languageConfigurationService: languageConfigurations, languageFeaturesService: languages });
	assert.equal(services.languageFeaturesService, languages);
	assert.equal(services.themeService.getColorTheme(), lightColorTheme);
	assert.ok(services.instantiationService.get(ILogService) instanceof NullLoggerService);
	services.dispose();
	assert.equal(languages.isDisposed, false);
	languages.dispose();
	languageConfigurations.dispose();
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
	using hover = new LanguageHoverService(model, services.languageFeaturesService.hoverProvider);
	assert.deepEqual(await hover.provideHover('stanza-public-test', new stanza.Position(1, 2)), { contents: ['Public hover'] });
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

	editor.view.element.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
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

test("standalone editor owns only the implicit model it creates", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const editor = stanza.editor.create(dom.window.document.querySelector<HTMLElement>("main")!, {
		value: "owned",
		language: "plaintext",
		resource: URI.parse("inmemory://stanza/owned.txt"),
	});
	const model = editor.getModel();

	editor.dispose();
	assert.equal(model.isDisposed(), true);
	assert.equal(createdWorkerCount, terminatedWorkerCount);
	assert.equal(stanza.editor.getModel(URI.parse("inmemory://stanza/owned.txt")), null);
	dom.window.close();
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
	const lateOverride = new LanguageFeaturesService(lateConfigurations);
	assert.throws(() => stanza.editor.create(dom.window.document.querySelector<HTMLElement>("main")!, {}, { languageFeaturesService: lateOverride }), /already initialized/);
	lateOverride.dispose();
	lateConfigurations.dispose();
	dom.window.close();
});
