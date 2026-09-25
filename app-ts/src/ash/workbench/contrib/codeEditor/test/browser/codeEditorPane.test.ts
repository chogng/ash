import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { h } from '../../../../../base/browser/dom.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../platform/theme/test/common/testThemeService.js';
import { darkColorTheme } from '../../../../../platform/theme/common/colorTheme.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { isCancellationError } from "../../../../../base/common/errors.js";
import { URI } from "../../../../../base/common/uri.js";
import { Position } from "../../../../../editor/common/core/position.js";
import { Range } from "../../../../../editor/common/core/range.js";
import { EditorPaneVisibility } from "../../../../browser/parts/editor/editorPane.js";
import { TextFileContentSource, type ITextFileService, type ResolvedTextFileContent, type TextFileResolveRequest } from "../../../../services/textfile/common/textFileService.js";
import { TestLanguageFeaturesService as LanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { type ILanguageDiagnosticsService, type LanguageDiagnosticsPublisher, type LanguageDiagnosticSnapshot } from "../../../../services/language/common/languageDiagnosticsService.js";
import { type TextModel } from "../../../../../editor/common/model/textModel.js";
import { EDITOR_FONT_DEFAULTS } from "../../../../../editor/common/config/fontInfo.js";
import type { EditorPaneOptions, EditorPanePartOptions } from "../../../../browser/parts/editor/textResourceEditor.js";
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITextModelResourceService } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { ILanguageFeatureDebounceService, LanguageFeatureDebounceService } from '../../../../../editor/common/services/languageFeatureDebounce.js';
import { ILanguageConfigurationService } from '../../../../../editor/common/languages/languageConfigurationRegistry.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { EditorOption } from '../../../../../editor/common/config/editorOptions.js';
import { EditorMinimapConfiguration } from '../../../../../editor/common/config/editorConfigurationSchema.js';
import { CodeEditorConfiguration } from '../../common/editorConfiguration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';

function createTestDom(markup: string): JSDOM {
	const dom = new JSDOM(markup);
	setIconResolver(dom.window.document, icon => getIconDefinition(icon));
	return dom;
}

const browserEnvironment = createTestDom("<!doctype html><body></body>");
browserEnvironment.window.HTMLCanvasElement.prototype.getContext = () => null;
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	ResizeObserver: class {
		observe(): void {}
		unobserve(): void {}
		disconnect(): void {}
	},
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

await import("../../../../../editor/editor.code.all.js");
await import('../../browser/quickaccess/gotoLineQuickAccess.js');
await import('../../browser/toggleMinimap.js');
await import('../../browser/toggleRenderWhitespace.js');
await import('../../browser/toggleRenderControlCharacter.js');
const { TextResourceEditor: EditorPane } = await import("../../../../browser/parts/editor/textResourceEditor.js");
const { createBrowserEditorPart } = await import('../../browser/browserEditorPart.js');
const { CodeEditorWidget } = await import('../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js');
const { createTestCodeEditor, registerCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { BrowserTextModelService } = await import("../../../../services/textmodelResolver/browser/browserTextModelService.js");
const { BrowserTextResourceStore } = await import("../../browser/browserTextResourceStore.js");
const { EditorTextDirection } = await import("../../../../../editor/browser/view.js");
const { EditorIndentationKind } = await import("../../../../../editor/common/core/misc/indentation.js");
const { EditorLineWrapping } = await import("../../../../../editor/common/config/editorOptions.js");

suiteTeardown(() => browserEnvironment.window.close());

test("Stanza editor pane loads, lays out, focuses, hides, and clears one editor part", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("from disk");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using languageService = new LanguageService();
	using language = languageService.registerLanguage({ id: 'typescript', extensions: ['.ts'] });
	using models = new BrowserTextModelService(resourceStore, { languageService });
	using services = paneServices(models);
	const pane = createPane(services, resourceStore, { textDirection: EditorTextDirection.RightToLeft, fontFamily: "Fira Code, monospace", fontSize: 16 });
	pane.create(parent);
	pane.layout({ width: 640, height: 480 });
	await pane.setInput({
		resource: URI.file("C:\\project\\main.ts"),
		label: "main.ts",
		initialText: "const alpha = 1;",
	}, new AbortController().signal);

	assert.equal(pane.getValue(), "const alpha = 1;");
	const control = pane.getControl();
	assert.ok(control instanceof CodeEditorWidget);
	assert.ok(control.getContribution('editor.contrib.findController'));
	assert.ok(control.getContribution('editor.contrib.inlayHints'));
	assert.ok(control.getContribution('store.contrib.stickyScrollController'));
	assert.deepEqual(pane.getStatus(), { lineNumber: 1, columnNumber: 1, languageId: "typescript", encoding: "UTF-8", endOfLine: "LF" });
	assert.equal(parent.querySelectorAll(".stanza-editor-pane").length, 1);
	assert.equal(parent.querySelectorAll(".stanza-editor").length, 1);
	const editor = parent.querySelector<HTMLElement>(".stanza-editor")!;
	const expectedFont = h(dom.window.document, "div");
	expectedFont.style.fontFamily = `"Fira Code", monospace, ${EDITOR_FONT_DEFAULTS.fontFamily}`;
	assert.equal(editor.dir, "rtl");
	assert.equal(editor.style.fontFamily, expectedFont.style.fontFamily);
	assert.equal(editor.style.fontSize, "16px");
	pane.focus();
	assert.equal(dom.window.document.activeElement?.classList.contains("stanza-editor-input"), true);
	assert.equal((dom.window.document.activeElement as HTMLTextAreaElement).dir, "rtl");
	pane.setVisible(EditorPaneVisibility.Hidden);
	assert.equal((parent.firstElementChild as HTMLElement).hidden, true);
	pane.setVisible(EditorPaneVisibility.Visible);
	assert.equal((parent.firstElementChild as HTMLElement).hidden, false);

	pane.clearInput();
	assert.equal(pane.getValue(), "");
	await assert.rejects(() => pane.saveAs(URI.file("C:\\project\\empty.ts")), /unloaded text editor/);
	assert.equal(parent.querySelectorAll(".stanza-editor").length, 0);
	pane.dispose();
	assert.equal(parent.children.length, 0);
	dom.window.close();
});

test('open code editor applies live view settings and actions without replacing its control', async () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	const parent = dom.window.document.querySelector<HTMLElement>('main')!;
	const resourceStore = new BrowserTextResourceStore(new ImmediateTextFiles('a long line of text'));
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	const configuration = services.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.wordWrap, EditorLineWrapping.On);
	await configuration.updateValue(EditorMinimapConfiguration.enabled, false);
	await configuration.updateValue(EditorMinimapConfiguration.side, 'left');
	using pane = createPane(services, resourceStore, {});
	pane.create(parent);
	await pane.setInput({ resource: URI.file('/project/settings.ts') }, new AbortController().signal);
	const control = pane.getControl();
	assert.ok(control instanceof CodeEditorWidget);
	assert.equal(control.getOption(EditorOption.wordWrap), 'on');
	assert.equal(control.getOption(EditorOption.minimap).enabled, false);
	assert.equal(control.getOption(EditorOption.minimap).side, 'left');

	await configuration.updateValue(CodeEditorConfiguration.wordWrap, EditorLineWrapping.Off);
	await configuration.updateValue(EditorMinimapConfiguration.enabled, true);
	await configuration.updateValue(EditorMinimapConfiguration.size, 'fit');
	assert.equal(pane.getControl(), control);
	assert.equal(control.getOption(EditorOption.wordWrap), 'off');
	assert.equal(control.getOption(EditorOption.minimap).enabled, true);
	assert.equal(control.getOption(EditorOption.minimap).size, 'fit');
	assert.equal(control.getOption(EditorOption.renderWhitespace), 'selection');
	assert.equal(control.getOption(EditorOption.renderControlCharacters), true);
	await services.get(ICommandService).executeCommand('editor.action.toggleRenderWhitespace');
	assert.equal(configuration.getValue(CodeEditorConfiguration.renderWhitespace), 'none');
	assert.equal(control.getOption(EditorOption.renderWhitespace), 'none');
	await services.get(ICommandService).executeCommand('editor.action.toggleRenderWhitespace');
	assert.equal(control.getOption(EditorOption.renderWhitespace), 'all');
	await services.get(ICommandService).executeCommand('editor.action.toggleRenderControlCharacter');
	assert.equal(configuration.getValue(CodeEditorConfiguration.renderControlCharacters), false);
	assert.equal(control.getOption(EditorOption.renderControlCharacters), false);
	await services.get(ICommandService).executeCommand('editor.action.toggleMinimap');
	assert.equal(configuration.getValue(EditorMinimapConfiguration.enabled), false);
	assert.equal(control.getOption(EditorOption.minimap).enabled, false);
	await services.get(ICommandService).executeCommand('editor.action.toggleMinimap');
	assert.equal(configuration.getValue(EditorMinimapConfiguration.enabled), true);
	assert.equal(control.getOption(EditorOption.minimap).enabled, true);
});

test('Workbench Go to Line command opens the active editor dialog and focuses its input', async () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	const parent = dom.window.document.querySelector<HTMLElement>('main')!;
	const resourceStore = new BrowserTextResourceStore(new ImmediateTextFiles('first\nsecond'));
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	using pane = createPane(services, resourceStore, {
		createPart: options => createBrowserEditorPart(services, options),
		showUnicodeHighlights: false,
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file('/project/goto.ts') }, new AbortController().signal);
	pane.focus();

	await services.get(ICommandService).executeCommand('workbench.action.gotoLine');
	const dialog = parent.querySelector<HTMLElement>('.stanza-editor-goto-line-widget');
	const input = dialog?.querySelector<HTMLInputElement>('input');
	assert.ok(dialog && input);
	assert.equal(dialog.hidden, false);
	assert.equal(dom.window.document.activeElement, input);
});

test('Stanza editor pane switches files without leaving the old model, DOM, or keyboard focus behind', async () => {
	const dom = createTestDom('<!doctype html><body><main></main><button id="outside">Outside</button></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>('main')!;
	const resourceStore = new BrowserTextResourceStore(new ImmediateTextFiles('first file'));
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	const parts: InstanceType<typeof CodeEditorWidget>[] = [];
	const pane = createPane(services, resourceStore, {
		createPart: options => {
			const part = createTestCodeEditor(options);
			parts.push(part);
			return part;
		},
	});
	try {
		pane.create(parent);
		pane.layout({ width: 640, height: 320 });
		await pane.setInput({ resource: URI.file('/project/first.ts'), label: 'first.ts' }, new AbortController().signal);
		const first = parts[0]!;
		const oldModel = first.getModel();
		assert.ok(oldModel);
		const oldDom = first.getDomNode();
		first.focus();
		assert.equal(first.hasTextFocus(), true);

		await pane.setInput({ resource: URI.file('/project/second.ts'), label: 'second.ts', initialText: 'second file' }, new AbortController().signal);

		assert.deepEqual({
			value: pane.getValue(),
			parts: parts.length,
			oldEditorDisposed: first.isDisposed,
			oldModelDisposed: oldModel.isDisposed(),
			oldDomConnected: oldDom.isConnected,
			mountedEditors: parent.querySelectorAll('.stanza-editor').length,
			newEditorFocused: parts[1]?.hasTextFocus(),
		}, {
			value: 'second file',
			parts: 2,
			oldEditorDisposed: true,
			oldModelDisposed: true,
			oldDomConnected: false,
			mountedEditors: 1,
			newEditorFocused: true,
		});

		const second = parts[1]!;
		const secondModel = second.getModel();
		assert.ok(secondModel);
		const outside = dom.window.document.querySelector<HTMLButtonElement>('#outside')!;
		outside.focus();
		assert.equal(dom.window.document.activeElement, outside);
		await pane.setInput({ resource: URI.file('/project/third.ts'), label: 'third.ts', initialText: 'third file' }, new AbortController().signal);
		assert.deepEqual({
			value: pane.getValue(),
			oldEditorDisposed: second.isDisposed,
			oldModelDisposed: secondModel.isDisposed(),
			mountedEditors: parent.querySelectorAll('.stanza-editor').length,
			focusStayedOutside: dom.window.document.activeElement === outside,
		}, {
			value: 'third file',
			oldEditorDisposed: true,
			oldModelDisposed: true,
			mountedEditors: 1,
			focusStayedOutside: true,
		});
	} finally {
		pane.dispose();
		dom.window.close();
	}
});

test("Stanza editor pane acquires the Workbench language service for its detected model", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("const value = 1;");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using languageService = new LanguageService();
	using language = languageService.registerLanguage({ id: 'typescript', extensions: ['.ts'] });
	using languages = new LanguageFeaturesService();
	using models = new BrowserTextModelService(resourceStore, { languageService, languageFeaturesService: languages });
	using services = paneServices(models, languages);
	const diagnostics = new RecordingLanguageDiagnosticsService();
	const pane = createPane(services, resourceStore, { languageDiagnosticsService: diagnostics });
	pane.create(parent);
	const resource = URI.file("C:\\project\\main.ts");

	await pane.setInput({ resource }, new AbortController().signal);

	assert.deepEqual(diagnostics.acquired.map(entry => ({ resource: entry.resource.toString(), languageId: entry.languageId })), [{ resource: resource.toString(), languageId: "typescript" }]);
	assert.equal(diagnostics.activeAcquisitions, 1);
	pane.clearInput();
	assert.equal(diagnostics.activeAcquisitions, 0);
	pane.dispose();
	dom.window.close();
});

class RecordingLanguageDiagnosticsService implements ILanguageDiagnosticsService {
	readonly acquired: Array<{ readonly resource: URI; readonly languageId: string; readonly model: TextModel }> = [];
	activeAcquisitions = 0;
	readonly onDidChangeDiagnostics = () => toDisposable(() => undefined);
	acquire(resource: URI, languageId: string, model: TextModel) {
		this.acquired.push({ resource, languageId, model });
		this.activeAcquisitions += 1;
		return toDisposable(() => { this.activeAcquisitions -= 1; });
	}
	createPublisher(): LanguageDiagnosticsPublisher { return { update: () => undefined, dispose: () => undefined, [Symbol.dispose]: () => undefined }; }
	getDiagnostics(): LanguageDiagnosticSnapshot | undefined { return undefined; }
	getAllDiagnostics(): readonly LanguageDiagnosticSnapshot[] { return []; }
}

test("Stanza editor pane releases a load cancelled before content resolution", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const pending = deferred<ResolvedTextFileContent>();
	const textFiles = { onDidChangeFiles: inertFileChanges, resolve: () => pending.promise, save: async () => ({ revision: undefined }) };
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	const pane = createPane(services, resourceStore, {});
	pane.create(parent);
	const controller = new AbortController();
	const opening = pane.setInput({ resource: URI.file("C:\\project\\slow.ts") }, controller.signal);
	controller.abort();
	pending.resolve({
		resource: URI.file("C:\\project\\slow.ts"),
		text: "late",
		source: TextFileContentSource.FileSystem,
		revision: "revision-1",
		encoding: "utf8",
	});

	await assert.rejects(opening, isCancellationError);
	assert.equal(parent.querySelectorAll(".stanza-editor").length, 0);
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane saves and reverts its shared model reference", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("from disk");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	const resource = URI.file("C:\\project\\main.ts");
	const reference = await models.acquire({ resource }, new AbortController().signal);
	const pane = createPane(services, resourceStore, {});
	pane.create(parent);
	await pane.setInput({ resource, label: "main.ts" }, new AbortController().signal);

	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (4) + 1)),
		text: "saved",
	}]);
	assert.equal(pane.isDirty, true);
	await pane.save();
	assert.deepEqual(textFiles.savedTexts, ["saved disk"]);
	assert.equal(pane.isDirty, false);

	reference.model.applyEdits([{
		range: Range.fromPositions(new Position((0) + 1, (5) + 1)),
		text: " locally",
	}]);
	textFiles.setText("from disk");
	await pane.revert();
	assert.equal(pane.getValue(), "from disk");
	assert.equal(pane.isDirty, false);

	reference.dispose();
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane trims trailing whitespace before saving", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("alpha  \n beta\t\n");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	const pane = createPane(services, resourceStore, {
		trimTrailingWhitespace: true,
		createPart: () => ({ layout: () => {}, focus: () => {}, getValue: () => "", updateOptions: () => {}, dispose: () => {}, [Symbol.dispose]: () => {} }),
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\trim.ts") }, new AbortController().signal);

	await pane.save();

	assert.deepEqual(textFiles.savedTexts, ["alpha\n beta\n"]);
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane inserts the configured final newline before saving", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("alpha");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	const pane = createPane(services, resourceStore, {
		insertFinalNewLine: true,
		createPart: () => ({ layout: () => {}, focus: () => {}, getValue: () => "", updateOptions: () => {}, dispose: () => {}, [Symbol.dispose]: () => {} }),
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\final-newline.ts") }, new AbortController().signal);

	await pane.save();

	assert.deepEqual(textFiles.savedTexts, ["alpha\n"]);
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane resolves extension first-line languages after loading an unknown file", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("#!/usr/bin/env demo\nprint('ok')");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using languageService = new LanguageService();
	using languages = new LanguageFeaturesService();
	using registration = languageService.registerLanguage({ id: "demo", firstLine: "#!.*\\bdemo" }, { priority: 100 });
	using models = new BrowserTextModelService(resourceStore, { languageService, languageFeaturesService: languages });
	using services = paneServices(models, languages);
	let languageId: string | undefined;
	const pane = createPane(services, resourceStore, {
		createPart: options => {
			languageId = options.model?.getLanguageId();
			return { layout: () => {}, focus: () => {}, getValue: () => "", updateOptions: () => {}, dispose: () => {}, [Symbol.dispose]: () => {} };
		},
	});
	pane.create(parent);

	await pane.setInput({ resource: URI.file("C:\\project\\script.cgi") }, new AbortController().signal);

	assert.equal(languageId, "demo");
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane forwards Workbench editor preferences to each created part", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("const value = 1;");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	let received: EditorPanePartOptions | undefined;
	const pane = createPane(services, resourceStore, {
		fontFamily: "Fira Code, monospace",
		fontSize: 16,
		lineHeight: 26,
		fontLigatures: true,
		experimentalGpuAcceleration: "on",
		lineWrapping: EditorLineWrapping.On,
		minimap: { enabled: false },
		renderLineHighlight: 'none',
		renderLineHighlightOnlyWhenFocus: true,
		cursorStyle: 'block-outline',
		cursorBlinking: 'solid',
		cursorSmoothCaretAnimation: 'explicit',
		cursorWidth: 3,
		cursorHeight: 18,
		lineNumbers: 'off',
		guides: { indentation: false },
		bracketPairColorization: { enabled: false },
		matchBrackets: "near",
		stickyScroll: { enabled: false },
		suggestions: false,
		inlineCompletions: false,
		parameterHints: false,
		inlayHints: { enabled: 'off' },
		codeLens: false,
		colorDecorators: false,
		colorDecoratorsActivatedOn: "click",
		colorDecoratorsLimit: 250,
		defaultColorDecorators: "always",
		formatOnSave: true,
		find: {
			seedSearchStringFromSelection: 'never',
			autoFindInSelection: 'always',
			loop: false,
		},
		indentation: { kind: EditorIndentationKind.Tabs, tabSize: 2 },
		showUnicodeHighlights: false,
		insertFinalNewLine: true,
		createPart: options => {
			received = options;
			return { layout: () => {}, focus: () => {}, getValue: () => "", updateOptions: () => {}, dispose: () => {}, [Symbol.dispose]: () => {} };
		},
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\configured.ts"), label: 'Configured file', readOnly: true }, new AbortController().signal);

	assert.equal(received?.ariaLabel, 'Configured file');
	assert.equal(received?.readOnly, true);
	assert.equal(received?.lineWrapping, EditorLineWrapping.On);
	assert.equal(received?.fontFamily, "Fira Code, monospace");
	assert.equal(received?.fontSize, 16);
	assert.equal(received?.lineHeight, 26);
	assert.equal(received?.fontLigatures, true);
	assert.equal(received?.experimentalGpuAcceleration, "on");
	assert.deepEqual(received?.minimap, { enabled: false });
	assert.equal(received?.renderLineHighlight, 'none');
	assert.equal(received?.renderLineHighlightOnlyWhenFocus, true);
	assert.equal(received?.cursorStyle, 'block-outline');
	assert.equal(received?.cursorBlinking, 'solid');
	assert.equal(received?.cursorSmoothCaretAnimation, 'explicit');
	assert.equal(received?.cursorWidth, 3);
	assert.equal(received?.cursorHeight, 18);
	assert.equal(received?.lineNumbers, 'off');
	assert.deepEqual(received?.guides, { indentation: false });
	assert.deepEqual(received?.bracketPairColorization, { enabled: false });
	assert.equal(received?.matchBrackets, "near");
	assert.deepEqual(received?.stickyScroll, { enabled: false });
	assert.equal(received?.suggestions, false);
	assert.equal(received?.inlineCompletions, false);
	assert.deepEqual(received?.parameterHints, { enabled: false });
	assert.deepEqual(received?.inlayHints, { enabled: 'off' });
	assert.equal(received?.codeLens, false);
	assert.equal(received?.colorDecorators, false);
	assert.equal(received?.colorDecoratorsActivatedOn, "click");
	assert.equal(received?.colorDecoratorsLimit, 250);
	assert.equal(received?.defaultColorDecorators, "always");
	assert.equal(received?.formatOnSave, true);
	assert.deepEqual(received?.find, {
		seedSearchStringFromSelection: 'never',
		autoFindInSelection: 'always',
		loop: false,
	});
	assert.deepEqual(received?.indentation, { kind: EditorIndentationKind.Tabs, tabSize: 2 });
	assert.equal(received?.showUnicodeHighlights, false);
	pane.dispose();
	dom.window.close();
});

test("Workbench owns the code editor save shortcut and reports failures", async () => {
	const dom = createTestDom("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("alpha");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	const errors: unknown[] = [];
	const pane = createPane(services, resourceStore, { onSaveError: error => errors.push(error) });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\save.ts") }, new AbortController().signal);

	const input = parent.querySelector<HTMLTextAreaElement>(".stanza-editor-input")!;
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "s" }));
	await waitFor(() => textFiles.savedTexts.length === 1);
	assert.equal(parent.querySelector(".stanza-editor-accessibility-status")?.textContent, "Saved");

	textFiles.failSave = true;
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "s" }));
	await waitFor(() => errors.length === 1);
	assert.equal(parent.querySelector(".stanza-editor-accessibility-status")?.textContent, "Save failed: conflict");

	pane.dispose();
	dom.window.close();
});

class ImmediateTextFiles implements ITextFileService {
	readonly savedTexts: string[] = [];
	readonly onDidChangeFiles = inertFileChanges;
	failSave = false;
	private revision = 1;

	constructor(private text: string) {}

	async resolve(request: TextFileResolveRequest): Promise<ResolvedTextFileContent> {
		return {
			resource: request.resource,
			text: request.bootstrapText ?? this.text,
			source: request.bootstrapText === undefined ? TextFileContentSource.FileSystem : TextFileContentSource.Bootstrap,
			revision: request.bootstrapText === undefined ? this.currentRevision() : undefined,
			encoding: "utf8",
		};
	}

	async save(request: { readonly text: string }): Promise<{ readonly revision: string | undefined }> {
		if (this.failSave) throw new Error("conflict");
		this.savedTexts.push(request.text);
		this.text = request.text;
		this.revision += 1;
		return { revision: this.currentRevision() };
	}

	setText(text: string): void {
		this.text = text;
		this.revision += 1;
	}

	private currentRevision(): string {
		return `revision-${this.revision}`;
	}
}

async function waitFor(predicate: () => boolean, timeout = 500): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Workbench editor state");
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

function inertFileChanges() {
	return {
		dispose() {},
		[Symbol.dispose]() {},
	};
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolver => {
		resolve = resolver;
	});
	return { promise, resolve };
}

test('Workbench status follows cursor movement through public editor events', async () => {
	const dom = createTestDom('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	const parent = dom.window.document.querySelector<HTMLElement>('main')!;
	const resourceStore = new BrowserTextResourceStore(new ImmediateTextFiles('alpha'));
	using models = new BrowserTextModelService(resourceStore);
	using services = paneServices(models);
	using pane = createPane(services, resourceStore, {});
	pane.create(parent);
	await pane.setInput({ resource: URI.file('/project/status.ts') }, new AbortController().signal);
	const columns: (number | undefined)[] = [];
	using listener = pane.onDidChangeStatus(() => columns.push(pane.getStatus().columnNumber));
	const input = parent.querySelector<HTMLTextAreaElement>('.stanza-editor-input')!;
	input.focus();
	input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowRight' }));
	assert.equal(pane.getStatus().columnNumber, 2);
	assert.ok(columns.includes(2));
});

function paneServices(models: ITextModelResourceService, languages?: LanguageFeaturesService): ServiceContainer {
	const services = new ServiceContainer();
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(ITextModelResourceService, models);
	services.registerSingleton(ILanguageFeatureDebounceService, () => new LanguageFeatureDebounceService());
	services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	services.registerInstance(ILogService, new NullLoggerService());
	if (languages) {
		services.registerInstance(ILanguageFeaturesService, languages);
		services.registerInstance(ILanguageConfigurationService, languages.languageConfigurationService);
	} else {
		services.registerSingleton(ILanguageFeaturesService, () => new LanguageFeaturesService());
		services.registerSingleton(ILanguageConfigurationService, accessor => (accessor.get(ILanguageFeaturesService) as LanguageFeaturesService).languageConfigurationService);
	}
	registerCodeEditorServices(services);
	return services;
}

function createPane(services: ServiceContainer, resourceStore: ConstructorParameters<typeof EditorPane>[0], options: EditorPaneOptions): InstanceType<typeof EditorPane> {
	return services.createInstance(EditorPane, resourceStore, options);
}

test('code editor creation rejects a missing language configuration registration', async () => {
	const resourceStore = new BrowserTextResourceStore(new ImmediateTextFiles('text'));
	using models = new BrowserTextModelService(resourceStore);
	using languages = new LanguageFeaturesService();
	using services = new ServiceContainer();
	services.registerInstance(ITextModelResourceService, models);
	services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	services.registerSingleton(IThemeService, () => new TestThemeService(darkColorTheme));
	services.registerInstance(ILanguageFeaturesService, languages);
	using pane = createPane(services, resourceStore, {});
	const parent = h(browserEnvironment.window.document, 'div');
	pane.create(parent);
	await assert.rejects(pane.setInput({ resource: URI.file('/project/missing-service.ts') }, new AbortController().signal), /languageConfigurationService/);
});
