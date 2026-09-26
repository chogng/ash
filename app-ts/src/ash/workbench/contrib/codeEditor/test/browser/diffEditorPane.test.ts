import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from "../../../../../base/common/uri.js";
import { Range } from '../../../../../editor/common/core/range.js';
import { TextEditorSelectionSource } from '../../../../../platform/editor/common/editor.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { CodeEditorConfiguration } from '../../common/editorConfiguration.js';
import { EditorLineWrapping, EditorOption, RenderLineNumbersType } from '../../../../../editor/common/config/editorOptions.js';
import { ICodeEditorService } from '../../../../../editor/browser/services/codeEditorService.js';
import { type DiffEditorWidget } from '../../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { IEditorPartsService } from '../../../../browser/parts/editor/editorParts.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { IEditorService, type EditorInput } from '../../../../services/editor/common/editorService.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from "../../../../../editor/common/diff/documentDiffProvider.js";
import { DefaultLinesDiffComputer } from "../../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";
import { type ITextModel } from '../../../../../editor/common/model.js';
import { EditorPaneVisibility } from "../../../../browser/parts/editor/editorPane.js";
import { EditorPaneSelectionChangeReason } from '../../../../common/editor.js';
import { TextFileContentSource, type ITextFileService, type ResolvedTextFileContent, type TextFileResolveRequest } from "../../../../services/textfile/common/textFileService.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { TextDiffEditor: DiffEditorPane } = await import("../../../../browser/parts/editor/textDiffEditor.js");
await import('../../../../../editor/contrib/diffEditorBreadcrumbs/browser/contribution.js');
await import('../../browser/toggleWordWrap.js');
const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { BrowserTextModelService } = await import("../../../../services/textmodelResolver/browser/browserTextModelService.js");
const { BrowserTextResourceStore } = await import("../../browser/browserTextResourceStore.js");
const { createDiffEditorInput, isDiffEditorInput } = await import("../../../../common/editor/diffEditorInput.js");
const { DiffEditorCommandsService, IDiffEditorCommandsService } = await import('../../../../browser/parts/editor/diffEditorCommandsService.js');
const { DIFF_FOCUS_SECONDARY_SIDE, DIFF_OPEN_SIDE, DIFF_SWAP_SIDES, GOTO_NEXT_CHANGE, SET_DIFF_VIEW_MODE_INLINE, SET_DIFF_VIEW_MODE_SIDE_BY_SIDE, SET_DIFF_VIEW_MODE_AUTOMATIC, TOGGLE_DIFF_IGNORE_TRIM_WHITESPACE, registerDiffEditorCommands } = await import('../../../../browser/parts/editor/diffEditorCommands.js');
registerDiffEditorCommands();

test('Diff commands navigate and focus the active comparison through the Workbench service', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = new BrowserTextModelService(resourceStore);
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	});
	pane.create(parent);
	pane.layout({ width: 600, height: 300 });
	const input = createDiffEditorInput(
		{ resource: URI.file('/command-before.ts'), initialText: 'before\nshared', label: 'before.ts' },
		{ resource: URI.file('/command-after.ts'), initialText: 'after\nshared', label: 'after.ts' },
	);
	await pane.setInput(input, new AbortController().signal);
	await Promise.resolve();
	const opened: unknown[] = [];
	const closed: unknown[] = [];
	container.registerInstance(IEditorPart, {
		activeInput: input,
		activePane: pane,
		closeEditor: async (editor: unknown) => { closed.push(editor); return true; },
	} as never);
	container.registerInstance(IEditorService, { openEditor: async (next: unknown) => { opened.push(next); } } as never);
	container.registerSingleton(IDiffEditorCommandsService, () => container.createInstance(DiffEditorCommandsService));
	const commands = container.get(ICommandService);
	const widget = pane.getControl();
	assert.ok(widget);
	await commands.executeCommand(GOTO_NEXT_CHANGE);
	assert.ok(widget.currentChangeRow >= 0);
	await commands.executeCommand(SET_DIFF_VIEW_MODE_INLINE);
	assert.equal(widget.viewMode, 'inline');
	assert.equal(parent.querySelector('.stanza-diff-inline-original-line')?.textContent, 'before');
	await commands.executeCommand(SET_DIFF_VIEW_MODE_SIDE_BY_SIDE);
	assert.equal(widget.viewMode, 'sideBySide');
	assert.equal(parent.querySelector('.stanza-diff-inline-original-line'), null);
	await commands.executeCommand(SET_DIFF_VIEW_MODE_AUTOMATIC);
	pane.layout({ width: 480, height: 300 });
	assert.equal(widget.viewMode, 'inline');
	pane.layout({ width: 800, height: 300 });
	assert.equal(widget.viewMode, 'sideBySide');
	await commands.executeCommand(DIFF_FOCUS_SECONDARY_SIDE);
	assert.equal(widget.originalEditor.getDomNode().contains(dom.window.document.activeElement), true);
	await commands.executeCommand(DIFF_OPEN_SIDE);
	assert.deepEqual(opened, [input.original]);
	await commands.executeCommand(TOGGLE_DIFF_IGNORE_TRIM_WHITESPACE);
	assert.equal(container.get(IConfigurationService).getValue('diffEditor.ignoreTrimWhitespace'), false);
	await commands.executeCommand(DIFF_SWAP_SIDES);
	const swapped = opened[1] as EditorInput;
	assert.ok(isDiffEditorInput(swapped));
	assert.equal(swapped.original.resource.toString(), input.modified.resource.toString());
	assert.deepEqual(closed, [input]);
	pane.dispose();
	dom.window.close();
});

test("Stanza diff pane rejects a missing Workbench diff computation service", () => {
	using services = new DisposableStore();
	assert.throws(() => createCodeEditorServices(services).createInstance(DiffEditorPane, new BrowserTextResourceStore(new BootstrapTextFiles()), undefined as never), /requires a Workbench diff computation service/);
});

test("Stanza diff pane acquires both models, lays out the review view, and releases both references", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const parent = requiredElement<HTMLElement>(dom.window.document, "main");
	const textFiles = new BootstrapTextFiles();
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const codeEditorService = container.get(ICodeEditorService);
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
		lineHeight: 24,
		fontFamily: "Test Mono",
		fontSize: 15,
		fontLigatures: true,
		showLineNumbers: false,
		showInlineChanges: false,
		loopChanges: false,
	});
	pane.create(parent);
	pane.layout({ width: 640, height: 480 });
	await pane.setInput(createDiffEditorInput(
		{ resource: URI.file("C:\\project\\before.ts"), initialText: "const oldValue = 1;", label: "before.ts" },
		{ resource: URI.file("C:\\project\\after.ts"), initialText: "const newValue = 2;", label: "after.ts" },
	), new AbortController().signal);

	assert.equal(parent.querySelectorAll(".stanza-diff-editor-pane").length, 1);
	assert.equal(parent.querySelectorAll(".stanza-diff-editor").length, 1);
	const editor = requiredElement<HTMLElement>(dom.window.document, ".stanza-diff-editor");
	const diffWidget = codeEditorService.listDiffEditors()[0] as DiffEditorWidget;
	assert.equal(editor.querySelectorAll('.stanza-editor').length, 2);
	assert.equal(diffWidget.originalEditor.getOption(EditorOption.lineNumbers).renderType, RenderLineNumbersType.Off);
	assert.equal(diffWidget.modifiedEditor.getOption(EditorOption.lineNumbers).renderType, RenderLineNumbersType.Off);
	assert.equal(diffWidget.modifiedEditor.getOption(EditorOption.fontFamily), 'Test Mono');
	assert.equal(diffWidget.modifiedEditor.getOption(EditorOption.fontSize), 15);
	assert.match(diffWidget.modifiedEditor.getOption(EditorOption.fontLigatures), /"liga" on/);
	const selectionReasons: EditorPaneSelectionChangeReason[] = [];
	using selectionListener = pane.onDidChangeSelection(reason => selectionReasons.push(reason));
	diffWidget.modifiedEditor.setSelection(new Range(1, 2, 1, 2), 'keyboard');
	pane.restoreSelection(new Range(1, 5, 1, 5), TextEditorSelectionSource.NAVIGATION);
	assert.equal(pane.getSelection()?.startColumn, 5);
	diffWidget.modifiedEditor.executeEdits('keyboard', [{ range: new Range(1, 5, 1, 5), text: 'x' }]);
	assert.ok(selectionReasons.includes(EditorPaneSelectionChangeReason.USER));
	assert.ok(selectionReasons.includes(EditorPaneSelectionChangeReason.NAVIGATION));
	assert.ok(selectionReasons.includes(EditorPaneSelectionChangeReason.EDIT));
	assert.match(parent.querySelector(".stanza-diff-editor")?.getAttribute("aria-label") ?? "", /before\.ts/);
	assert.equal(codeEditorService.listDiffEditors().length, 1);
	pane.focus();
	assert.equal(editor.contains(dom.window.document.activeElement), true);
	pane.setVisible(EditorPaneVisibility.Hidden);
	assert.equal((parent.firstElementChild as HTMLElement).hidden, true);
	pane.clearInput();
	assert.equal(parent.querySelectorAll(".stanza-diff-editor").length, 0);
	assert.equal(codeEditorService.listDiffEditors().length, 0);
	pane.dispose();
	assert.equal(parent.children.length, 0);
	dom.window.close();
});

test('Diff pane recomputes an open comparison when ignore-trim-whitespace changes', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = new BrowserTextModelService(resourceStore);
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const configuration = container.get(IConfigurationService);
	const seenLimits: number[] = [];
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(options => seenLimits.push(options.maxComputationTimeMs)),
	});
	pane.create(parent);
	await pane.setInput(createDiffEditorInput(
		{ resource: URI.file('/before.ts'), initialText: 'word', label: 'before.ts' },
		{ resource: URI.file('/after.ts'), initialText: 'word ', label: 'after.ts' },
	), new AbortController().signal);
	await Promise.resolve();
	const diffWidget = container.get(ICodeEditorService).listDiffEditors()[0] as DiffEditorWidget;
	assert.equal(diffWidget.diff?.hunks.length, 0);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false);
	await Promise.resolve();
	assert.equal(diffWidget.diff?.hunks.length, 1);
	await configuration.updateValue(CodeEditorConfiguration.diffMaxComputationTime, 17);
	await Promise.resolve();
	assert.deepEqual(seenLimits, [5_000, 5_000, 17]);
	pane.dispose();
	dom.window.close();
});

test('Diff pane follows the modified language override and language changes', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = new BrowserTextModelService(resourceStore);
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const configuration = container.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false, { overrideIdentifier: 'typescript' });
	let computations = 0;
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(() => computations++),
	});
	pane.create(parent);
	const modifiedInput = { resource: URI.file('/language-after.ts'), initialText: 'word ', languageId: 'typescript', label: 'after.ts' };
	await pane.setInput(createDiffEditorInput(
		{ resource: URI.file('/language-before.ts'), initialText: 'word', label: 'before.ts' },
		modifiedInput,
	), new AbortController().signal);
	await Promise.resolve();
	const diffWidget = container.get(ICodeEditorService).listDiffEditors()[0] as DiffEditorWidget;
	assert.equal(diffWidget.diff?.hunks.length, 1);
	assert.equal(computations, 1);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, true, { overrideIdentifier: 'javascript' });
	assert.equal(computations, 1);
	using modified = await models.acquire(modifiedInput, new AbortController().signal);
	modified.model.setLanguage('javascript');
	await Promise.resolve();
	assert.equal(diffWidget.diff?.hunks.length, 0);
	assert.equal(computations, 2);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false, { overrideIdentifier: 'javascript' });
	await Promise.resolve();
	assert.equal(diffWidget.diff?.hunks.length, 1);
	pane.dispose();
	dom.window.close();
});

test('Diff pane follows configured word wrap and keeps its temporary toggle in the open view', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = new BrowserTextModelService(resourceStore);
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const configuration = container.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.wordWrap, EditorLineWrapping.On);
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	});
	pane.create(parent);
	pane.layout({ width: 400, height: 200 });
	await pane.setInput(createDiffEditorInput(
		{ resource: URI.file('/wrap-before.ts'), initialText: 'old ' + 'value '.repeat(40) },
		{ resource: URI.file('/wrap-after.ts'), initialText: 'new ' + 'value '.repeat(40) },
	), new AbortController().signal);
	await Promise.resolve();
	const editor = requiredElement<HTMLElement>(dom.window.document, '.stanza-diff-editor');
	assert.equal(editor.classList.contains('word-wrapped'), true);
	container.registerInstance(IEditorPartsService, { activePane: pane } as unknown as IEditorPartsService);
	await container.get(ICommandService).executeCommand('editor.action.toggleWordWrap');
	assert.equal(editor.classList.contains('word-wrapped'), false);
	await configuration.updateValue('diffEditor.wordWrap', 'off');
	assert.equal(editor.classList.contains('word-wrapped'), false);
	pane.toggleWordWrap();
	assert.equal(editor.classList.contains('word-wrapped'), false);
	await configuration.updateValue('diffEditor.wordWrap', 'on');
	assert.equal(editor.classList.contains('word-wrapped'), true);
	pane.dispose();
	dom.window.close();
});

test('Diff pane updates hidden unchanged regions when settings change', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const parent = requiredElement<HTMLElement>(dom.window.document, 'main');
	const resourceStore = new BrowserTextResourceStore(new BootstrapTextFiles());
	using models = new BrowserTextModelService(resourceStore);
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const configuration = container.get(IConfigurationService);
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
	});
	pane.create(parent);
	pane.layout({ width: 800, height: 300 });
	const lines = Array.from({ length: 36 }, (_, index) => `shared ${index + 1}`);
	await pane.setInput(createDiffEditorInput(
		{ resource: URI.file('/hidden-before.ts'), initialText: lines.join('\n') },
		{ resource: URI.file('/hidden-after.ts'), initialText: [...lines.slice(0, -1), 'changed'].join('\n') },
	), new AbortController().signal);
	await Promise.resolve();
	const regions = () => parent.querySelectorAll('.ash-diff-hidden-region');
	assert.equal(regions().length, 0);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsContextLineCount, 1);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsMinimumLineCount, 3);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsRevealLineCount, 2);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsEnabled, true);
	assert.equal(regions().length, 2);
	assert.equal(regions()[0]?.querySelector('.ash-diff-hidden-region-count')?.textContent, '33 hidden lines');
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsMinimumLineCount, 100);
	assert.equal(regions().length, 0);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsMinimumLineCount, 3);
	assert.equal(regions().length, 2);
	await configuration.updateValue(CodeEditorConfiguration.diffHideUnchangedRegionsEnabled, false);
	assert.equal(regions().length, 0);
	pane.dispose();
	dom.window.close();
});

class BootstrapTextFiles implements ITextFileService {
	readonly onDidChangeFiles = () => ({ dispose() {}, [Symbol.dispose]() {} });

	async resolve(request: TextFileResolveRequest): Promise<ResolvedTextFileContent> {
		return {
			resource: request.resource,
			text: request.bootstrapText ?? "",
			source: request.bootstrapText === undefined ? TextFileContentSource.FileSystem : TextFileContentSource.Bootstrap,
			revision: undefined,
			encoding: "utf8",
		};
	}

	async save(): Promise<{ readonly revision: string | undefined }> {
		return { revision: undefined };
	}
}

class PaneTestDiffComputationService implements IDocumentDiffProvider {
	readonly onDidChange = Event.None;
	constructor(private readonly observe?: (options: IDocumentDiffProviderOptions) => void) {}

	async computeDiff(original: ITextModel, modified: ITextModel, options: IDocumentDiffProviderOptions, token: CancellationToken): Promise<IDocumentDiff> {
		assert.equal(token.isCancellationRequested, false);
		this.observe?.(options);
		const result = new DefaultLinesDiffComputer().computeDiff(original.getLinesContent(), modified.getLinesContent(), options);
		return { identical: original.getValue() === modified.getValue(), quitEarly: result.hitTimeout, changes: result.changes, moves: result.moves };
	}

	dispose(): void {}

	[Symbol.dispose](): void {
		this.dispose();
	}
}

function requiredElement<T extends Element>(ownerDocument: Document, selector: string): T {
	const element = ownerDocument.querySelector<T>(selector);
	if (!element) throw new Error(`Missing ${selector}`);
	return element;
}
