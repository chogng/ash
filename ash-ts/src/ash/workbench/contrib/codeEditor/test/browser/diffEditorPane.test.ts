import { StandaloneCodeEditorService } from '../../../../../editor/standalone/browser/standaloneCodeEditorService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { URI } from "../../../../../base/common/uri.js";
import { type DiffComputationRequest, type IDiffComputationService } from "../../../../../editor/common/diff/diffComputationService.js";
import { type LineDiff } from "../../../../../editor/common/diff/lineDiff.js";
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
const { BrowserTextModelService } = await import("../../../../services/textmodelResolver/browser/browserTextModelService.js");
const { BrowserTextResourceStore } = await import("../../browser/browserTextResourceStore.js");
const { createDiffEditorInput } = await import("../../browser/diffEditorInput.js");
const { createEditorBrowserServices } = await import('../../../../../editor/browser/services/contribution.js');

test("Stanza diff pane rejects a missing Workbench diff computation service", () => {
	assert.throws(() => new DiffEditorPane(new BrowserTextResourceStore(new BootstrapTextFiles()), undefined as never), /requires a Workbench diff computation service/);
});

test("Stanza diff pane acquires both models, lays out the review view, and releases both references", async () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	const parent = requiredElement<HTMLElement>(dom.window.document, "main");
	const textFiles = new BootstrapTextFiles();
	const resourceStore = new BrowserTextResourceStore(textFiles);
	using models = new BrowserTextModelService(resourceStore);
	const editorServices = createEditorBrowserServices(new StandaloneCodeEditorService());
	using codeEditorService = editorServices.codeEditorService;
	const pane = new DiffEditorPane(resourceStore, {
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

class PaneTestDiffComputationService implements IDiffComputationService {
	async compute(_request: DiffComputationRequest, signal: AbortSignal): Promise<LineDiff> {
		signal.throwIfAborted();
		return Object.freeze({ rows: Object.freeze([]), hunks: Object.freeze([]) });
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
