import { StandaloneCodeEditorService } from '../../../../../editor/standalone/browser/standaloneCodeEditorService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from "../../../../../base/common/uri.js";
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { CodeEditorConfiguration } from '../../common/editorConfiguration.js';
import { type IDocumentDiff, type IDocumentDiffProvider, type IDocumentDiffProviderOptions } from "../../../../../editor/common/diff/documentDiffProvider.js";
import { DefaultLinesDiffComputer } from "../../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js";
import { type ITextModel } from '../../../../../editor/common/model.js';
import { EditorPaneVisibility } from "../../../../browser/parts/editor/editorPane.js";
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

const { DiffEditorPane } = await import("../../browser/diffEditorPane.js");
const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { BrowserTextModelService } = await import("../../../../services/textmodelResolver/browser/browserTextModelService.js");
const { BrowserTextResourceStore } = await import("../../browser/browserTextResourceStore.js");
const { createDiffEditorInput } = await import("../../browser/diffEditorInput.js");

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
	using codeEditorService = new StandaloneCodeEditorService();
	using services = new DisposableStore();
	const pane = createCodeEditorServices(services).createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(),
		codeEditorService,
		lineHeight: 24,
		fontFamily: "Test Mono",
		fontSize: 15,
		fontLigatures: true,
		showLineNumbers: false,
		showInlineChanges: false,
		loopChanges: false,
		breadcrumbs: false,
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
	assert.equal(editor.classList.contains("hide-line-numbers"), true);
	assert.equal(editor.style.fontFamily.startsWith('"Test Mono", '), true);
	assert.equal(editor.style.fontFamily.endsWith('monospace'), true);
	assert.equal(editor.style.fontSize, "15px");
	assert.equal(editor.style.fontFeatureSettings.includes('"liga" on'), true);
	assert.equal(parent.querySelector(".stanza-diff-editor-breadcrumbs"), null);
	assert.match(parent.querySelector(".stanza-diff-editor")?.getAttribute("aria-label") ?? "", /before\.ts/);
	assert.equal(codeEditorService.listDiffEditors().length, 1);
	pane.focus();
	assert.equal(dom.window.document.activeElement?.classList.contains("stanza-diff-editor"), true);
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
	using codeEditorService = new StandaloneCodeEditorService();
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const configuration = container.get(IConfigurationService);
	const seenLimits: number[] = [];
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(options => seenLimits.push(options.maxComputationTimeMs)),
		codeEditorService,
		breadcrumbs: false,
	});
	pane.create(parent);
	await pane.setInput(createDiffEditorInput(
		{ resource: URI.file('/before.ts'), initialText: 'word', label: 'before.ts' },
		{ resource: URI.file('/after.ts'), initialText: 'word ', label: 'after.ts' },
	), new AbortController().signal);
	await Promise.resolve();
	assert.ok(parent.querySelector('.stanza-diff-editor-row.unchanged'));
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false);
	await Promise.resolve();
	assert.ok(parent.querySelector('.stanza-diff-editor-row.modified'));
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
	using codeEditorService = new StandaloneCodeEditorService();
	using services = new DisposableStore();
	const container = createCodeEditorServices(services);
	const configuration = container.get(IConfigurationService);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false, { overrideIdentifier: 'typescript' });
	let computations = 0;
	const pane = container.createInstance(DiffEditorPane, resourceStore, {
		modelService: models,
		createComputationService: () => new PaneTestDiffComputationService(() => computations++),
		codeEditorService,
		breadcrumbs: false,
	});
	pane.create(parent);
	const modifiedInput = { resource: URI.file('/language-after.ts'), initialText: 'word ', languageId: 'typescript', label: 'after.ts' };
	await pane.setInput(createDiffEditorInput(
		{ resource: URI.file('/language-before.ts'), initialText: 'word', label: 'before.ts' },
		modifiedInput,
	), new AbortController().signal);
	await Promise.resolve();
	assert.ok(parent.querySelector('.stanza-diff-editor-row.modified'));
	assert.equal(computations, 1);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, true, { overrideIdentifier: 'javascript' });
	assert.equal(computations, 1);
	using modified = await models.acquire(modifiedInput, new AbortController().signal);
	modified.model.setLanguage('javascript');
	await Promise.resolve();
	assert.ok(parent.querySelector('.stanza-diff-editor-row.unchanged'));
	assert.equal(computations, 2);
	await configuration.updateValue(CodeEditorConfiguration.diffIgnoreTrimWhitespace, false, { overrideIdentifier: 'javascript' });
	await Promise.resolve();
	assert.ok(parent.querySelector('.stanza-diff-editor-row.modified'));
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
