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
import { registerBuiltinLanguageDescriptions } from '../../../../../editor/common/languages/languageBuiltinDescriptions.js';
import { toDisposable } from "../../../../../base/common/lifecycle.js";
import { type ILanguageDiagnosticsService, type LanguageDiagnosticsPublisher, type LanguageDiagnosticSnapshot } from "../../../../../editor/common/services/languageDiagnosticsService.js";
import { type TextModel } from "../../../../../editor/common/model/textModel.js";
import { EDITOR_FONT_DEFAULTS } from "../../../../../editor/common/config/fontInfo.js";
import type { EditorPanePartOptions } from "../../browser/codeEditorPane.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
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
const { CodeEditorPane: EditorPane } = await import("../../browser/codeEditorPane.js");
const { CodeEditorWidget } = await import('../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js');
const { BrowserTextModelService } = await import("../../../../services/textmodelResolver/browser/browserTextModelService.js");
const { BrowserTextResourceStore } = await import("../../browser/browserTextResourceStore.js");
const { EditorTextDirection } = await import("../../../../../editor/browser/view.js");
const { EditorIndentationKind } = await import("../../../../../editor/common/core/misc/indentation.js");
const { EditorLineWrapping } = await import("../../../../../editor/common/config/editorOptions.js");

suiteTeardown(() => browserEnvironment.window.close());

test("Stanza editor pane loads, lays out, focuses, hides, and clears one editor part", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("from disk");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using languageService = new LanguageService();
	using builtinLanguages = registerBuiltinLanguageDescriptions(languageService.languages);
	using models = new BrowserTextModelService(resourceStore, { languageService });
	const pane = new EditorPane(resourceStore, { modelService: models, textDirection: EditorTextDirection.RightToLeft, fontFamily: "Fira Code, monospace", fontSize: 16 });
	pane.create(parent);
	pane.layout({ width: 640, height: 480 });
	await pane.setInput({
		resource: URI.file("C:\\project\\main.ts"),
		label: "main.ts",
		initialText: "const alpha = 1;",
	}, new AbortController().signal);

	assert.equal(pane.getValue(), "const alpha = 1;");
	assert.deepEqual(pane.getStatus(), { lineNumber: 1, columnNumber: 1, languageId: "typescript", encoding: "UTF-8", endOfLine: "LF" });
	assert.equal(parent.querySelectorAll(".stanza-editor-pane").length, 1);
	assert.equal(parent.querySelectorAll(".stanza-editor").length, 1);
	const editor = parent.querySelector<HTMLElement>(".stanza-editor")!;
	const expectedFont = dom.window.document.createElement("div");
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
	assert.equal(parent.querySelectorAll(".stanza-editor").length, 0);
	pane.dispose();
	assert.equal(parent.children.length, 0);
	dom.window.close();
});

test('Stanza editor pane switches files without leaving the old model, DOM, or keyboard focus behind', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main><button id="outside">Outside</button></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>('main')!;
	const resourceStore = new BrowserTextResourceStore(new ImmediateTextFiles('first file'));
	using models = new BrowserTextModelService(resourceStore);
	const parts: InstanceType<typeof CodeEditorWidget>[] = [];
	const pane = new EditorPane(resourceStore, {
		modelService: models,
		createPart: options => {
			const part = new CodeEditorWidget(options);
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
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("const value = 1;");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using languageService = new LanguageService();
	using builtinLanguages = registerBuiltinLanguageDescriptions(languageService.languages);
	using languages = new LanguageFeaturesService();
	using models = new BrowserTextModelService(resourceStore, { languageService, languageFeaturesService: languages });
	const diagnostics = new RecordingLanguageDiagnosticsService();
	const pane = new EditorPane(resourceStore, { modelService: models, languageFeaturesService: languages, languageConfigurationService: languages.languageConfigurationService, languageDiagnosticsService: diagnostics });
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
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const pending = deferred<ResolvedTextFileContent>();
	const textFiles = { onDidChangeFiles: inertFileChanges, resolve: () => pending.promise, save: async () => ({ revision: undefined }) };
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	const pane = new EditorPane(resourceStore, { modelService: models });
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
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("from disk");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	const resource = URI.file("C:\\project\\main.ts");
	const reference = await models.acquire({ resource }, new AbortController().signal);
	const pane = new EditorPane(resourceStore, { modelService: models });
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
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("alpha  \n beta\t\n");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	const pane = new EditorPane(resourceStore, {
		modelService: models,
		trimTrailingWhitespace: true,
		createPart: () => ({ layout: () => {}, focus: () => {}, getValue: () => "", dispose: () => {}, [Symbol.dispose]: () => {} }),
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\trim.ts") }, new AbortController().signal);

	await pane.save();

	assert.deepEqual(textFiles.savedTexts, ["alpha\n beta\n"]);
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane inserts the configured final newline before saving", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("alpha");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	const pane = new EditorPane(resourceStore, {
		modelService: models,
		insertFinalNewLine: true,
		createPart: () => ({ layout: () => {}, focus: () => {}, getValue: () => "", dispose: () => {}, [Symbol.dispose]: () => {} }),
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\final-newline.ts") }, new AbortController().signal);

	await pane.save();

	assert.deepEqual(textFiles.savedTexts, ["alpha\n"]);
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane resolves extension first-line languages after loading an unknown file", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("#!/usr/bin/env demo\nprint('ok')");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using languageService = new LanguageService();
	using languages = new LanguageFeaturesService();
	using registration = languageService.registerLanguage({ id: "demo", firstLine: "#!.*\\bdemo" }, { priority: 100 });
	using models = new BrowserTextModelService(resourceStore, { languageService, languageFeaturesService: languages });
	let languageId: string | undefined;
	const pane = new EditorPane(resourceStore, {
		modelService: models,
		languageFeaturesService: languages,
		languageConfigurationService: languages.languageConfigurationService,
		createPart: options => {
			languageId = options.languageId;
			return { layout: () => {}, focus: () => {}, getValue: () => "", dispose: () => {}, [Symbol.dispose]: () => {} };
		},
	});
	pane.create(parent);

	await pane.setInput({ resource: URI.file("C:\\project\\script.cgi") }, new AbortController().signal);

	assert.equal(languageId, "demo");
	pane.dispose();
	dom.window.close();
});

test("Stanza editor pane forwards Workbench editor preferences to each created part", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("const value = 1;");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	let received: EditorPanePartOptions | undefined;
	const pane = new EditorPane(resourceStore, {
		modelService: models,
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
			return { layout: () => {}, focus: () => {}, getValue: () => "", dispose: () => {}, [Symbol.dispose]: () => {} };
		},
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\configured.ts") }, new AbortController().signal);

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
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const parent = dom.window.document.querySelector<HTMLElement>("main")!;
	const textFiles = new ImmediateTextFiles("alpha");
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	const errors: unknown[] = [];
	const pane = new EditorPane(resourceStore, { modelService: models, onSaveError: error => errors.push(error) });
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
