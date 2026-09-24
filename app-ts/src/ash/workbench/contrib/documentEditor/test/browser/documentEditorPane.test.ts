import { Event } from '../../../../../base/common/event.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { type IDimension } from "../../../../../base/browser/dom.js";
import { URI } from "../../../../../base/common/uri.js";
import type { IFileChangeEvent } from "../../../../../platform/files/common/files.js";
import { TextFileSaveConflictError, type ITextFileService, type ResolvedTextFileContent, type TextFileResolveRequest, type TextFileSaveRequest } from "../../../../services/textfile/common/textFileService.js";
import { DOCUMENT_EDITOR_ID } from "../../browser/documentEditorInput.js";
import { DocumentEditorPane as EditorPane } from "../../browser/documentEditorPane.js";
import { nodeViews as profileNodeViews } from "../../../../../editor/contrib/academic/browser/nodeViews.js";
import { inlineNodeViews as citationInlineNodeViews, nodeViews as citationNodeViews } from "../../../../../editor/contrib/citation/browser/nodeViews.js";
import { citationToolbarActions } from "../../../../../editor/contrib/citation/browser/toolbarAction.js";
import { createReferenceIndexPlugin } from "../../../../../editor/contrib/citation/common/references.js";
import { createAcademicDocumentSchema, createEmptyAcademicDocument } from "../../../../../editor/contrib/academic/common/schema.js";
import { createDocumentDecoration, DocumentDecorationSet } from "../../../../../editor/common/model/documentDecoration.js";
import { createDocumentPlugin, DocumentPluginKey } from "../../../../../editor/common/model/documentPlugin.js";
import { DOCUMENT_FRAGMENT_CLIPBOARD_MIME, serializeDocument } from "../../../../../editor/common/model/documentSerialization.js";
import { createDefaultDocumentSchema, DocumentSchema } from "../../../../../editor/common/model/documentSchema.js";
import { h } from "../../../../../base/browser/dom.js";

await import("../../../../../editor/contrib/documentEditor.contribution.js");

function documentAction(parent: ParentNode, actionId: string): HTMLButtonElement {
	const button = parent.querySelector<HTMLButtonElement>(`[data-action-id='${actionId}'] button`);
	assert.ok(button, `Missing Stanza document action '${actionId}'`);
	return button;
}

test("Stanza editor migrates plain text and edits a structured paragraph", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Title\nBody");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	pane.layout({ width: 640, height: 480 });

	const layoutContainer = parent.querySelector<HTMLElement>(".ash-text-editor-widget-layout");
	const editorContainer = parent.querySelector<HTMLElement>(".ash-text-editor-widget-pane");
	assert.deepEqual({
		layout: { width: layoutContainer?.style.width, height: layoutContainer?.style.height },
		editor: { width: editorContainer?.style.width, height: editorContainer?.style.height },
	}, {
		layout: { width: "640px", height: "480px" },
		editor: { width: "640px", height: "480px" },
	});

	await pane.setInput({
		resource: URI.file("C:\\project\\paper.ash-academic"),
		contentType: "application/vnd.ash.academic-document+json",
		label: "paper",
	}, new AbortController().signal);

	assert.equal(pane.id, DOCUMENT_EDITOR_ID);
	assert.equal(parent.querySelectorAll("textarea").length, 2);
	assert.deepEqual([...parent.querySelectorAll<HTMLTextAreaElement>("textarea")].map(textarea => textarea.getAttribute("aria-label")), ["Paragraph", "Paragraph"]);
	const first = parent.querySelector<HTMLTextAreaElement>("textarea");
	assert.ok(first);
	first.value = "Edited title";
	first.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "Edited title");
	assert.equal(pane.isDirty, true);

	await pane.save();
	assert.equal(pane.isDirty, false);
	assert.match(files.lastSavedText, /ash\.document/);
	environment.window.close();
});

test("DocumentWorkingCopy clears dirty state after an untitled save succeeds", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	let saveCalls = 0;
	const parent = h(environment.window.document, "main");
	const pane = new EditorPane(new MemoryTextFiles(""), { onSave: async () => { saveCalls += 1; } });
	pane.create(parent);
	await pane.setInput({ resource: URI.parse("untitled:academic/draft"), initialText: "Draft" }, new AbortController().signal);
	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.value = "Changed";
	textarea.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.isDirty, true);
	await pane.save();
	assert.equal(saveCalls, 1);
	assert.equal(pane.isDirty, false);
	pane.dispose();
	environment.window.close();
});

test("Stanza refuses a stale conditional save even before a file-change notification arrives", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Initial");
	const parent = h(environment.window.document, "main");
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);
	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.value = "Local";
	textarea.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	files.setExternalText("External");

	await assert.rejects(pane.save(), TextFileSaveConflictError);
	assert.equal(pane.isDirty, true);
	assert.equal(pane.hasExternalChange, true);
	assert.equal(files.lastSavedText, "");
	environment.window.close();
});

test('Document pane owns and releases the working copy when its input is cleared', async () => {
	const environment = new JSDOM('<!doctype html><body></body>');
	try {
		using pane = new EditorPane(new MemoryTextFiles('Original'));
		const parent = environment.window.document.body;
		pane.create(parent);
		await pane.setInput({ resource: URI.parse('untitled:document/lifetime') }, new AbortController().signal);
		const reference = pane.workingCopy;
		assert.ok(reference);
		pane.clearInput();
		assert.equal(pane.workingCopy, undefined);
		assert.equal(parent.querySelector('textarea'), null);
		assert.equal(pane.isDirty, false);
		await assert.rejects(pane.save(), /no active working copy/);
		await pane.setInput({ resource: URI.parse('untitled:document/reopened') }, new AbortController().signal);
		assert.notEqual(pane.workingCopy, reference);
		assert.equal(pane.getDocument().content[0]?.content[0]?.text, 'Original');
	} finally {
		environment.window.close();
	}
});

test("Stanza routes block keyboard commands through Stanza", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Hello\nWorld\nStanza");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const textareas = (): HTMLTextAreaElement[] => Array.from(parent.querySelectorAll<HTMLTextAreaElement>("textarea.stanza-document-text-input"));
	const blockTexts = (): string[] => pane.getDocument().content.map(block => block.content.find(child => child.text !== undefined)?.text ?? "");
	const dispatchKey = (textarea: HTMLTextAreaElement, key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent => {
		const event = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers });
		textarea.dispatchEvent(event);
		return event;
	};

	let fields = textareas();
	assert.equal(fields.length, 3);
	fields[0]!.focus();
	fields[0]!.setSelectionRange(2, 2);
	assert.equal(dispatchKey(fields[0]!, "Enter").defaultPrevented, true);
	assert.deepEqual(blockTexts(), ["He", "llo", "World", "Stanza"]);
	fields = textareas();
	assert.equal(environment.window.document.activeElement, fields[1]);
	assert.equal(fields[1]!.selectionStart, 0);

	fields[1]!.focus();
	fields[1]!.setSelectionRange(fields[1]!.value.length, fields[1]!.value.length);
	assert.equal(dispatchKey(fields[1]!, "Delete").defaultPrevented, true);
	assert.deepEqual(blockTexts(), ["He", "lloWorld", "Stanza"]);

	fields = textareas();
	fields[1]!.focus();
	fields[1]!.setSelectionRange(0, 0);
	assert.equal(dispatchKey(fields[1]!, "Backspace").defaultPrevented, true);
	assert.deepEqual(blockTexts(), ["HelloWorld", "Stanza"]);

	fields = textareas();
	fields[0]!.focus();
	assert.equal(dispatchKey(fields[0]!, "Enter", { ctrlKey: true }).defaultPrevented, true);
	assert.deepEqual(blockTexts(), ["HelloWorld", "", "Stanza"]);
	fields = textareas();
	assert.equal(environment.window.document.activeElement, fields[1]);

	assert.equal(dispatchKey(fields[1]!, "ArrowDown", { altKey: true }).defaultPrevented, true);
	assert.deepEqual(blockTexts(), ["HelloWorld", "Stanza", ""]);
	fields = textareas();
	assert.equal(environment.window.document.activeElement, fields[2]);
	assert.equal(dispatchKey(fields[2]!, "ArrowUp", { altKey: true }).defaultPrevented, true);
	assert.deepEqual(blockTexts(), ["HelloWorld", "", "Stanza"]);
	environment.window.close();
});

test("Stanza projects plugin decorations onto rich text runs", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Hello");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	const key = new DocumentPluginKey<DocumentDecorationSet>("search");
	const plugin = createDocumentPlugin(key, {
		init: context => {
			const textNode = context.document.content[0]?.content.find(child => child.text !== undefined);
			if (!textNode) throw new Error("Expected a migrated text node");
			return new DocumentDecorationSet([createDocumentDecoration({ id: "search-hit", from: { nodeId: textNode.id, offset: 1 }, to: { nodeId: textNode.id, offset: 4 }, className: "search-hit", attrs: { "data-source": "test" } })]);
		},
		apply: (value, context) => value.map(context.previousDocument, context.schema, context.transaction),
	}, { decorations: state => state });
	using pane = new EditorPane(files, { plugins: [plugin] });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const editor = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	const hit = editor?.querySelector<HTMLElement>(".search-hit");
	assert.ok(editor);
	assert.ok(hit);
	assert.equal(editor.getAttribute("aria-label"), "Paragraph");
	assert.equal(editor.getAttribute("aria-multiline"), "true");
	assert.equal(hit.textContent, "ell");
	assert.equal(hit.dataset.textNodeId, pane.getDocument().content[0]?.content[0]?.id);
	assert.equal(hit.dataset.decorationIds, "search-hit");
	assert.equal(hit.dataset.source, "test");
	environment.window.close();
});

test("Stanza commits textarea composition as one Stanza transaction", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Hello");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.focus();
	textarea.setSelectionRange(5, 5);
	textarea.dispatchEvent(new environment.window.Event("select", { bubbles: true }));
	textarea.dispatchEvent(new environment.window.Event("compositionstart", { bubbles: true }));
	textarea.value = "Hello世";
	textarea.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	const compositionEnd = new environment.window.Event("compositionend", { bubbles: true });
	Object.defineProperty(compositionEnd, "data", { value: "世" });
	textarea.dispatchEvent(compositionEnd);

	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "Hello世");
	const undo = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true });
	parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input")?.dispatchEvent(undo);
	assert.equal(undo.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "Hello");
	environment.window.close();
});

test("Stanza accepts a schema and custom node view without changing Stanza common nodes", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createDefaultDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "custom-paragraph", content: [schema.createText("Inside callout", { id: "custom-text" })] });
	const document = schema.createDocument([schema.createNode("blockquote", { id: "custom-callout", content: [paragraph] })], "custom-document");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	let updates = 0;
	let disposals = 0;
	using pane = new EditorPane(new MemoryTextFiles(""), {
		schema,
		nodeViews: {
			blockquote: ({ previousElement, renderChildren }) => {
				const element = previousElement ?? h(parent.ownerDocument, "aside");
				element.className = "custom-callout-view";
				renderChildren(element);
				return {
					element,
					update: ({ renderChildren: updateChildren }) => {
						updates += 1;
						updateChildren(element);
						return true;
					},
					dispose: () => disposals += 1,
				};
			},
		},
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic"), initialText: serializeDocument(document, schema) }, new AbortController().signal);

	const callout = parent.querySelector<HTMLElement>("aside.custom-callout-view");
	assert.ok(callout);
	assert.equal(callout.dataset.nodeId, "custom-callout");
	assert.equal(callout.querySelector<HTMLTextAreaElement>("textarea")?.value, "Inside callout");
	assert.equal(pane.getDocument().content[0]?.type, "blockquote");
	const textarea = callout.querySelector<HTMLTextAreaElement>("textarea");
	assert.ok(textarea);
	textarea.value = "Updated callout";
	textarea.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(updates, 1);
	assert.equal(pane.getDocument().content[0]?.content[0]?.content[0]?.text, "Updated callout");
	pane.clearInput();
	assert.equal(disposals, 1);
	environment.window.close();
});

test("Stanza projects and edits the generic group, typed-block, and line hierarchy", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = new DocumentSchema({
		topNodeType: "article",
		nodes: {
			article: { kind: "root", content: [{ type: "group", min: 1 }] },
			group: { kind: "group", content: [{ group: "stanza-block", min: 1 }] },
			textBlock: { kind: "block", groups: ["stanza-block"], content: [{ type: "richLine", min: 1 }] },
			richLine: { kind: "line", content: [{ type: "text", max: 1 }] },
			text: { kind: "text" },
		},
	});
	const firstLine = schema.createNode("richLine", { id: "line-1", content: [schema.createText("First", { id: "line-text-1" })] });
	const secondLine = schema.createNode("richLine", { id: "line-2", content: [schema.createText("Second", { id: "line-text-2" })] });
	const document = schema.createDocument([schema.createNode("group", { id: "group-1", content: [
		schema.createNode("textBlock", { id: "block-1", content: [firstLine, secondLine] }),
	] })], "article-1");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles(""), { schema });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\hierarchy.ash-academic"), initialText: serializeDocument(document, schema) }, new AbortController().signal);

	assert.equal(parent.querySelectorAll(".stanza-document-group[data-node-kind='group']").length, 1);
	assert.equal(parent.querySelectorAll(".stanza-document-block[data-node-kind='block']").length, 1);
	const lines = parent.querySelectorAll<HTMLElement>(".stanza-document-line[data-node-kind='line']");
	assert.equal(lines.length, 2);
	const secondInput = lines[1]?.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(secondInput);
	secondInput.value = "Updated";
	secondInput.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.getDocument().content[0]?.content[0]?.content[1]?.content[0]?.text, "Updated");
	environment.window.close();
});

test("Stanza projects Academic wrappers while editing Stanza child blocks", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createAcademicDocumentSchema();
	const document = schema.createDocument([
		schema.createNode("title", { id: "academic-title", content: [schema.createNode("heading", { id: "title-heading", content: [schema.createText("Paper title", { id: "title-text" })] })] }),
		schema.createNode("abstract", { id: "academic-abstract", content: [schema.createNode("paragraph", { id: "abstract-paragraph", content: [schema.createText("Summary", { id: "abstract-text" })] })] }),
		schema.createNode("section", { id: "academic-section", content: [schema.createNode("heading", { id: "section-heading", content: [schema.createText("Introduction", { id: "section-title-text" })] }), schema.createNode("paragraph", { id: "section-paragraph", content: [schema.createText("Body", { id: "section-body-text" })] })] }),
	], "academic-document");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles(""), { schema, nodeViews: profileNodeViews, outlineNavigator: true });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic"), initialText: serializeDocument(document, schema) }, new AbortController().signal);

	const title = parent.querySelector<HTMLElement>("header.ash-academic-title");
	const abstract = parent.querySelector<HTMLElement>("section.ash-academic-abstract");
	const section = parent.querySelector<HTMLElement>("section.ash-academic-section");
	assert.ok(title);
	assert.ok(abstract);
	assert.ok(section);
	assert.equal(title.dataset.nodeId, "academic-title");
	assert.equal(title.getAttribute("aria-label"), "Document title");
	assert.equal(abstract.dataset.academicRole, "abstract");
	assert.equal(section.dataset.academicRole, "section");
	assert.equal(parent.querySelectorAll("textarea.stanza-document-text-input").length, 4);
	assert.deepEqual(pane.getOutline().map(entry => ({ nodeId: entry.nodeId, title: entry.title, depth: entry.depth })), [
		{ nodeId: "title-heading", title: "Paper title", depth: 0 },
		{ nodeId: "section-heading", title: "Introduction", depth: 0 },
	]);
	const outlineEntries = parent.querySelectorAll<HTMLButtonElement>(".stanza-document-outline-entry");
	assert.deepEqual([...outlineEntries].map(entry => entry.textContent), ["Paper title", "Introduction"]);
	outlineEntries[1]!.click();
	const sectionInput = section.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(sectionInput);
	assert.equal(environment.window.document.activeElement, sectionInput);
	assert.equal(sectionInput.selectionStart, 0);

	const titleInput = title.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(titleInput);
	titleInput.value = "Updated title";
	titleInput.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.getDocument().content[0]?.content[0]?.content[0]?.text, "Updated title");
	assert.ok(parent.querySelector("header.ash-academic-title"));
	pane.clearInput();
	assert.equal(parent.querySelector<HTMLElement>(".stanza-document-outline")?.hidden, true);
	environment.window.close();
});

test("Stanza renders and deletes Academic citation inline nodes", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createAcademicDocumentSchema();
	const citation = schema.createNode("citation", { id: "browser-citation", attrs: { key: "smith-2024", label: "[Smith 2024]" } });
	const paragraph = schema.createNode("paragraph", { id: "citation-paragraph", content: [schema.createText("See ", { id: "citation-before" }), citation, schema.createText(" for details", { id: "citation-after" })] });
	const document = schema.createDocument([schema.createNode("title", { id: "citation-title", content: [schema.createNode("heading", { id: "citation-title-heading", content: [schema.createText("Citations", { id: "citation-title-text" })] })] }), schema.createNode("abstract", { id: "citation-abstract", content: [schema.createNode("paragraph", { id: "citation-abstract-paragraph" })] }), schema.createNode("section", { id: "citation-section", content: [schema.createNode("heading", { id: "citation-section-heading", content: [schema.createText("References", { id: "citation-section-text" })] }), paragraph] })], "citation-document");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles(""), { schema, nodeViews: profileNodeViews, inlineNodeViews: citationInlineNodeViews });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\citations.ash-academic"), initialText: serializeDocument(document, schema) }, new AbortController().signal);

	const citationElement = parent.querySelector<HTMLElement>(".ash-citation");
	const editor = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input[data-block-id='citation-paragraph']");
	assert.ok(citationElement);
	assert.ok(editor);
	assert.equal(citationElement.textContent, "[Smith 2024]");
	assert.equal(citationElement.dataset.citationKey, "smith-2024");
	citationElement.click();
	assert.equal(citationElement.classList.contains("stanza-document-inline-node-selected"), true);

	const deletion = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" });
	editor.dispatchEvent(deletion);
	assert.equal(deletion.defaultPrevented, true);
	assert.equal(pane.getDocument().content.some(node => node.type === "section" && node.content.some(child => child.content.some(inline => inline.type === "citation"))), false);
	assert.equal(parent.querySelector(".ash-citation"), null);
	environment.window.close();
});

test("Stanza exposes Academic citation insertion as a toolbar action", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const prompts = ["smith-2024", "[Smith 2024]"];
	Object.defineProperty(environment.window, "prompt", { configurable: true, value: () => prompts.shift() ?? null });
	const schema = createAcademicDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "toolbar-paragraph", content: [schema.createText("See", { id: "toolbar-text" })] });
	const document = schema.createDocument([paragraph], "toolbar-document");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles(""), { schema, nodeViews: profileNodeViews, inlineNodeViews: citationInlineNodeViews, toolbarActions: citationToolbarActions });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\toolbar.ash-academic"), initialText: serializeDocument(document, schema) }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea[data-block-id='toolbar-paragraph']");
	assert.ok(textarea);
	textarea.focus();
	textarea.setSelectionRange(3, 3);
	textarea.dispatchEvent(new environment.window.Event("select", { bubbles: true }));
	const citationButton = documentAction(parent, "citation");
	assert.equal(citationButton.disabled, false);
	citationButton.click();
	const inserted = pane.getDocument().content[0]?.content.find(node => node.type === "citation");
	assert.equal(inserted?.attrs.key, "smith-2024");
	assert.equal(inserted?.attrs.label, "[Smith 2024]");
	environment.window.close();
});

test("Stanza renders resolved citations and bibliography references", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createAcademicDocumentSchema();
	const citation = schema.createNode("citation", { id: "resolved-citation", attrs: { key: "smith-2024" } });
	const paragraph = schema.createNode("paragraph", { id: "resolved-paragraph", content: [schema.createText("See "), citation] });
	const reference = schema.createNode("reference", { id: "resolved-reference", attrs: { key: "smith-2024" }, content: [schema.createNode("paragraph", { id: "resolved-reference-paragraph", content: [schema.createText("Smith, 2024")] })] });
	const document = schema.createDocument([
		schema.createNode("title", { content: [schema.createNode("heading", { content: [schema.createText("Citations")] })] }),
		schema.createNode("abstract", { content: [schema.createNode("paragraph")] }),
		schema.createNode("section", { content: [schema.createNode("heading", { content: [schema.createText("Body")] }), paragraph] }),
		schema.createNode("bibliography", { content: [reference] }),
	], "resolved-document");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles(""), { schema, nodeViews: { ...profileNodeViews, ...citationNodeViews }, inlineNodeViews: citationInlineNodeViews, plugins: [createReferenceIndexPlugin()] });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\resolved.ash-academic"), initialText: serializeDocument(document, schema) }, new AbortController().signal);

	const citationElement = parent.querySelector<HTMLElement>(".ash-citation");
	const referenceElement = parent.querySelector<HTMLElement>(".ash-citation-reference");
	assert.ok(citationElement);
	assert.ok(referenceElement);
	assert.equal(citationElement.textContent, "[1]");
	assert.equal(citationElement.dataset.citationOrdinal, "1");
	assert.equal(citationElement.classList.contains("ash-citation-unresolved"), false);
	assert.equal(referenceElement.dataset.referenceKey, "smith-2024");
	environment.window.close();
});

test("Stanza exposes reference insertion as a citation toolbar action", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const prompts = ["smith-2024", "Smith, 2024"];
	Object.defineProperty(environment.window, "prompt", { configurable: true, value: () => prompts.shift() ?? null });
	const schema = createAcademicDocumentSchema();
	const paragraph = schema.createNode("paragraph", { id: "reference-toolbar-paragraph", content: [schema.createText("Body")] });
	const document = schema.createDocument([paragraph], "reference-toolbar-document");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles(""), { schema, nodeViews: { ...profileNodeViews, ...citationNodeViews }, inlineNodeViews: citationInlineNodeViews, toolbarActions: citationToolbarActions });
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\reference-toolbar.ash-academic"), initialText: serializeDocument(document, schema) }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea[data-block-id='reference-toolbar-paragraph']");
	assert.ok(textarea);
	textarea.focus();
	const referenceButton = documentAction(parent, "reference");
	assert.equal(referenceButton.disabled, false);
	referenceButton.click();
	const bibliography = pane.getDocument().content.find(node => node.type === "bibliography");
	assert.ok(bibliography);
	assert.equal(bibliography.content[0]?.attrs.key, "smith-2024");
	assert.equal(bibliography.content[0]?.content[0]?.content[0]?.text, "Smith, 2024");
	environment.window.close();
});

test("Stanza uses the Academic empty document through revert", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const schema = createAcademicDocumentSchema();
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles(""), {
		schema,
		createEmptyDocument: () => createEmptyAcademicDocument(schema),
		nodeViews: profileNodeViews,
	});
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\empty.ash-academic") }, new AbortController().signal);

	assert.deepEqual(pane.getDocument().content.map(node => node.type), ["title", "abstract"]);
	assert.ok(parent.querySelector("header.ash-academic-title"));
	assert.ok(parent.querySelector("section.ash-academic-abstract"));
	assert.equal(parent.querySelectorAll("textarea.stanza-document-text-input").length, 2);

	const titleInput = parent.querySelector<HTMLTextAreaElement>("header.ash-academic-title textarea.stanza-document-text-input");
	assert.ok(titleInput);
	titleInput.value = "Temporary title";
	titleInput.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.isDirty, true);

	await pane.revert();
	assert.deepEqual(pane.getDocument().content.map(node => node.type), ["title", "abstract"]);
	assert.equal(parent.querySelector<HTMLTextAreaElement>("header.ash-academic-title textarea.stanza-document-text-input")?.value, "");
	assert.equal(pane.isDirty, false);
	environment.window.close();
});

test("Stanza projects read-only inputs without accepting model mutations", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const parent = h(environment.window.document, "main");
	const pane = new EditorPane(new MemoryTextFiles("Hello"));
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic"), readOnly: true }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	assert.equal(textarea.readOnly, true);
	assert.equal(textarea.getAttribute("aria-readonly"), "true");
	assert.equal([...parent.querySelectorAll<HTMLButtonElement>(".stanza-structured-format-toolbar button")].every(button => button.disabled), true);
	assert.equal([...parent.querySelectorAll<HTMLSelectElement>(".stanza-structured-format-toolbar select")].every(select => select.disabled), true);
	textarea.value = "Rejected";
	textarea.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "Hello");
	const enter = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
	textarea.dispatchEvent(enter);
	assert.equal(enter.defaultPrevented, false);
	pane.dispose();
	environment.window.close();
});

test("Stanza routes text undo and redo through Stanza history", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Hello");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const textareas = (): HTMLTextAreaElement[] => Array.from(parent.querySelectorAll<HTMLTextAreaElement>("textarea.stanza-document-text-input"));
	const dispatchKey = (textarea: HTMLTextAreaElement, key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent => {
		const event = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key, ...modifiers });
		textarea.dispatchEvent(event);
		return event;
	};

	let fields = textareas();
	fields[0]!.focus();
	fields[0]!.setSelectionRange(2, 2);
	assert.equal(dispatchKey(fields[0]!, "Enter").defaultPrevented, true);
	assert.equal(textareas().length, 2);

	fields = textareas();
	const undo = dispatchKey(fields[1]!, "z", { ctrlKey: true });
	assert.equal(undo.defaultPrevented, true);
	assert.equal(textareas().length, 1);
	assert.equal(environment.window.document.activeElement, textareas()[0]);

	const redo = dispatchKey(textareas()[0]!, "z", { ctrlKey: true, shiftKey: true });
	assert.equal(redo.defaultPrevented, true);
	assert.equal(textareas().length, 2);
	assert.equal(environment.window.document.activeElement, textareas()[1]);
	assert.equal(textareas()[1]!.selectionStart, 0);
	environment.window.close();
});

test("Stanza creates a hard break with Shift+Enter", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Hello");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.focus();
	textarea.setSelectionRange(2, 2);
	const event = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", shiftKey: true });
	textarea.dispatchEvent(event);
	assert.equal(event.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.type), ["text", "hardBreak", "text"]);
	assert.deepEqual(pane.getDocument().content[0]?.content.filter(node => node.text !== undefined).map(node => node.text), ["He", "llo"]);
	assert.ok(parent.querySelector(".stanza-document-rich-text-input br"));
	environment.window.close();
});

test("Stanza deletes a selection spanning a hard break", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "Hello" },
					{ id: "break-1", type: "hardBreak", attrs: {}, content: [], marks: [] },
					{ id: "text-2", type: "text", attrs: {}, content: [], marks: [], text: "world" },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const editor = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(editor);
	const runs = Array.from(editor.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	const selection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(runs[0]!.firstChild!, 2);
	range.setEnd(runs[1]!.firstChild!, 3);
	selection?.removeAllRanges();
	selection?.addRange(range);
	const event = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" });
	editor.dispatchEvent(event);
	assert.equal(event.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.type), ["text", "text"]);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.text), ["He", "ld"]);
	environment.window.close();
});

test("Stanza renders semantic lists and splits list items", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "list-1",
				type: "bulletList",
				attrs: {},
				content: [{
					id: "item-1",
					type: "listItem",
					attrs: {},
					content: [{
						id: "paragraph-1",
						type: "paragraph",
						attrs: {},
						content: [{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "oneTwo" }],
						marks: [],
					}],
					marks: [],
				}],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	assert.equal(parent.querySelectorAll("ul").length, 1);
	assert.equal(parent.querySelectorAll("ul > li").length, 1);
	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.focus();
	textarea.setSelectionRange(3, 3);
	const event = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
	textarea.dispatchEvent(event);

	assert.equal(event.defaultPrevented, true);
	assert.equal(parent.querySelectorAll("ul > li").length, 2);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(item => item.content[0]?.content[0]?.text), ["one", "Two"]);
	environment.window.close();
});

test("Stanza indents and outdents list items with Tab", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "list-1",
				type: "bulletList",
				attrs: {},
				content: [
					{ id: "item-1", type: "listItem", attrs: {}, content: [{ id: "paragraph-1", type: "paragraph", attrs: {}, content: [{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "one" }], marks: [] }], marks: [] },
					{ id: "item-2", type: "listItem", attrs: {}, content: [{ id: "paragraph-2", type: "paragraph", attrs: {}, content: [{ id: "text-2", type: "text", attrs: {}, content: [], marks: [], text: "two" }], marks: [] }], marks: [] },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	let textareas = Array.from(parent.querySelectorAll<HTMLTextAreaElement>("textarea.stanza-document-text-input"));
	textareas[1]!.focus();
	const indent = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
	textareas[1]!.dispatchEvent(indent);
	assert.equal(indent.defaultPrevented, true);
	assert.equal(parent.querySelector("ul")?.children.length, 1);
	assert.equal(parent.querySelectorAll("ul ul > li").length, 1);

	textareas = Array.from(parent.querySelectorAll<HTMLTextAreaElement>("textarea.stanza-document-text-input"));
	const outdent = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true });
	textareas[1]!.dispatchEvent(outdent);
	assert.equal(outdent.defaultPrevented, true);
	assert.equal(parent.querySelector("ul")?.children.length, 2);
	assert.equal(parent.querySelectorAll("ul ul").length, 0);
	environment.window.close();
});

test("Stanza exits an empty list item on the second Enter", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{ id: "list-1", type: "bulletList", attrs: {}, content: [{ id: "item-1", type: "listItem", attrs: {}, content: [{ id: "paragraph-1", type: "paragraph", attrs: {}, content: [], marks: [] }], marks: [] }], marks: [] }],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.focus();
	const event = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
	textarea.dispatchEvent(event);
	assert.equal(event.defaultPrevented, true);
	assert.equal(parent.querySelector("ul"), null);
	assert.equal(pane.getDocument().content[0]?.type, "paragraph");
	environment.window.close();
});

test("Stanza exposes a block toolbar for block and list formats", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Hello");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const toolbar = parent.querySelector<HTMLDivElement>(".stanza-structured-format-toolbar");
	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(toolbar);
	assert.ok(textarea);
	assert.equal(toolbar.hidden, false);
	assert.ok(toolbar.querySelector(".ash-toolbar"));
	textarea.focus();
	documentAction(toolbar, "heading").click();
	assert.equal(pane.getDocument().content[0]?.type, "heading");
	assert.ok(parent.querySelector("h2"));
	assert.equal(documentAction(toolbar, "heading").classList.contains("checked"), true);

	documentAction(toolbar, "bulletList").click();
	assert.equal(pane.getDocument().content[0]?.type, "bulletList");
	assert.equal(parent.querySelectorAll("ul > li").length, 1);
	documentAction(toolbar, "orderedList").click();
	assert.equal(pane.getDocument().content[0]?.type, "orderedList");
	assert.equal(parent.querySelectorAll("ol > li").length, 1);
	assert.equal(documentAction(toolbar, "orderedList").classList.contains("checked"), true);

	documentAction(toolbar, "paragraph").click();
	assert.equal(pane.getDocument().content[0]?.content[0]?.content[0]?.type, "paragraph");
	documentAction(toolbar, "table").click();
	assert.equal(parent.querySelectorAll("table").length, 1);
	assert.equal(parent.querySelectorAll("table td").length, 4);
	environment.window.close();
});

test("Stanza formats selected text with persistent typography marks", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles("Hello"));
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\formatted.ash-academic") }, new AbortController().signal);

	const toolbar = parent.querySelector<HTMLDivElement>(".stanza-structured-format-toolbar");
	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	const fontFamily = parent.querySelector<HTMLSelectElement>("select[aria-label='Font family']");
	const fontSize = parent.querySelector<HTMLSelectElement>("select[aria-label='Font size']");
	assert.ok(toolbar);
	assert.ok(textarea);
	assert.ok(fontFamily);
	assert.ok(fontSize);
	assert.equal(toolbar.dataset.context, "text");
	assert.ok(documentAction(toolbar, "bold").querySelector(".ash-icon"));

	textarea.focus();
	textarea.setSelectionRange(1, 4);
	textarea.dispatchEvent(new environment.window.Event("select", { bubbles: true }));
	fontFamily.value = "serif";
	fontFamily.dispatchEvent(new environment.window.Event("change", { bubbles: true }));
	fontSize.value = "18";
	fontSize.dispatchEvent(new environment.window.Event("change", { bubbles: true }));
	documentAction(toolbar, "bold").click();

	let styled = pane.getDocument().content[0]?.content.find(node => node.text === "ell");
	assert.ok(styled);
	assert.deepEqual(styled.marks, [
		{ type: "textStyle", attrs: { fontFamily: "serif", fontSize: 18 } },
		{ type: "strong", attrs: {} },
	]);
	const styledRun = parent.querySelector<HTMLElement>(".stanza-document-mark-textStyle[data-font-family='serif']");
	assert.ok(styledRun);
	assert.equal(styledRun.style.fontSize, "18px");
	assert.equal(fontFamily.value, "serif");
	assert.equal(fontSize.value, "18");
	assert.equal(documentAction(toolbar, "bold").classList.contains("checked"), true);

	fontFamily.value = "";
	fontFamily.dispatchEvent(new environment.window.Event("change", { bubbles: true }));
	styled = pane.getDocument().content[0]?.content.find(node => node.text === "ell");
	assert.ok(styled);
	assert.deepEqual(styled.marks, [{ type: "strong", attrs: {} }]);
	environment.window.close();
});

test("Stanza toggles blockquotes and inserts horizontal rules", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Quoted");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const toolbar = parent.querySelector<HTMLDivElement>(".stanza-structured-format-toolbar");
	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(toolbar);
	assert.ok(textarea);
	textarea.focus();
	documentAction(toolbar, "blockquote").click();
	assert.equal(parent.querySelectorAll("blockquote").length, 1);
	assert.equal(documentAction(toolbar, "blockquote").classList.contains("checked"), true);

	documentAction(toolbar, "blockquote").click();
	assert.equal(parent.querySelectorAll("blockquote").length, 0);
	assert.equal(documentAction(toolbar, "blockquote").classList.contains("checked"), false);

	documentAction(toolbar, "horizontalRule").click();
	assert.equal(parent.querySelectorAll("hr.stanza-document-horizontal-rule").length, 1);
	assert.deepEqual(pane.getDocument().content.map(node => node.type), ["paragraph", "horizontalRule"]);
	environment.window.close();
});

test("Stanza navigates table cells with Tab and exposes row and column operations", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Hello");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const toolbar = parent.querySelector<HTMLDivElement>(".stanza-structured-format-toolbar");
	const source = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(toolbar);
	assert.ok(source);
	source.focus();
	documentAction(toolbar, "table").click();

	let cells = Array.from(parent.querySelectorAll<HTMLTextAreaElement>("table td textarea"));
	assert.equal(cells.length, 4);
	cells[0]!.focus();
	const next = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
	cells[0]!.dispatchEvent(next);
	assert.equal(next.defaultPrevented, true);
	assert.equal(environment.window.document.activeElement, cells[1]);

	const previous = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab", shiftKey: true });
	cells[1]!.dispatchEvent(previous);
	assert.equal(previous.defaultPrevented, true);
	assert.equal(environment.window.document.activeElement, cells[0]);

	cells = Array.from(parent.querySelectorAll<HTMLTextAreaElement>("table td textarea"));
	cells.at(-1)!.focus();
	const appendRow = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" });
	cells.at(-1)!.dispatchEvent(appendRow);
	assert.equal(appendRow.defaultPrevented, true);
	assert.equal(parent.querySelectorAll("table td").length, 6);
	assert.equal(environment.window.document.activeElement, parent.querySelectorAll<HTMLTextAreaElement>("table td textarea")[4]);

	documentAction(toolbar, "insertTableRow").click();
	assert.equal(parent.querySelectorAll("table td").length, 8);
	documentAction(toolbar, "insertTableColumn").click();
	assert.equal(parent.querySelectorAll("table td").length, 12);
	documentAction(toolbar, "deleteTableColumn").click();
	assert.equal(parent.querySelectorAll("table td").length, 8);
	documentAction(toolbar, "deleteTableRow").click();
	assert.equal(parent.querySelectorAll("table td").length, 6);
	const activeCell = environment.window.document.activeElement as HTMLTextAreaElement;
	const undo = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true });
	activeCell.dispatchEvent(undo);
	assert.equal(undo.defaultPrevented, true);
	assert.equal(parent.querySelectorAll("table td").length, 8);
	const redo = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "y", ctrlKey: true });
	(environment.window.document.activeElement as HTMLTextAreaElement).dispatchEvent(redo);
	assert.equal(redo.defaultPrevented, true);
	assert.equal(parent.querySelectorAll("table td").length, 6);
	environment.window.close();
});

test("Stanza renders inline image nodes in the rich surface", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "Before" },
					{ id: "image-1", type: "image", attrs: { src: "https://example.test/image.png", alt: "Example" }, content: [], marks: [] },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const image = parent.querySelector<HTMLImageElement>(".stanza-document-rich-text-input img");
	assert.ok(image);
	assert.equal(image.src, "https://example.test/image.png");
	assert.equal(image.alt, "Example");
	image.click();
	assert.equal(image.classList.contains("stanza-document-inline-node-selected"), true);
	const rich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(rich);
	const remove = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Delete" });
	rich.dispatchEvent(remove);
	assert.equal(remove.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content.some(node => node.type === "image"), false);
	const undo = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true });
	rich.dispatchEvent(undo);
	assert.equal(undo.defaultPrevented, true);
	const restoredImage = parent.querySelector<HTMLImageElement>(".stanza-document-rich-text-input img");
	assert.ok(restoredImage);
	assert.equal(restoredImage.classList.contains("stanza-document-inline-node-selected"), true);
	environment.window.close();
});

test("Stanza turns an image clipboard paste into an image node", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles("Before");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.focus();
	textarea.setSelectionRange(3, 3);
	const imageFile = new environment.window.File(["image-bytes"], "pasted.png", { type: "image/png" });
	const paste = new environment.window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: { files: [imageFile], items: [] } });
	textarea.dispatchEvent(paste);
	await waitFor(() => pane.getDocument().content[0]?.content[1]?.type === "image");

	assert.equal(paste.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content[1]?.type, "image");
	assert.match(String(pane.getDocument().content[0]?.content[1]?.attrs.src), /^data:image\/png;base64,/);
	environment.window.close();
});

test("Stanza inserts a pasted image at a rich-text selection", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "Hello" },
					{ id: "text-2", type: "text", attrs: {}, content: [], marks: [{ type: "strong", attrs: {} }], text: " world" },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const editor = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(editor);
	const run = editor.querySelector<HTMLElement>("[data-text-node-id='text-1']");
	assert.ok(run?.firstChild);
	const selection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(run.firstChild, 2);
	range.collapse(true);
	selection?.removeAllRanges();
	selection?.addRange(range);
	const imageFile = new environment.window.File(["image-bytes"], "rich-paste.png", { type: "image/png" });
	const paste = new environment.window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: { files: [imageFile], items: [] } });
	editor.dispatchEvent(paste);
	await waitFor(() => pane.getDocument().content[0]?.content.some(node => node.type === "image") === true);

	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.type), ["text", "image", "text", "text"]);
	assert.deepEqual(pane.getDocument().content[0]?.content.filter(node => node.text !== undefined).map(node => node.text), ["He", "llo", " world"]);
	assert.equal(pane.getDocument().content[0]?.content.at(-1)?.marks[0]?.type, "strong");
	const undo = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true });
	editor.dispatchEvent(undo);
	assert.equal(undo.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content.some(node => node.type === "image"), false);
	const redo = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true, shiftKey: true });
	editor.dispatchEvent(redo);
	assert.equal(redo.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content.some(node => node.type === "image"), true);
	const suffixRun = editor.querySelectorAll<HTMLElement>("[data-text-node-id]")[1];
	assert.ok(suffixRun?.firstChild);
	const suffixSelection = environment.window.document.getSelection();
	const suffixRange = environment.window.document.createRange();
	suffixRange.setStart(suffixRun.firstChild, 0);
	suffixRange.collapse(true);
	suffixSelection?.removeAllRanges();
	suffixSelection?.addRange(suffixRange);
	const backspace = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Backspace" });
	editor.dispatchEvent(backspace);
	assert.equal(backspace.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content.some(node => node.type === "image"), false);
	environment.window.close();
});

test("Stanza renders and edits marked inline runs", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "H" },
					{ id: "text-2", type: "text", attrs: {}, content: [], marks: [{ type: "strong", attrs: {} }], text: "ell" },
					{ id: "text-3", type: "text", attrs: {}, content: [], marks: [], text: "o" },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const rich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(rich);
	let runs = Array.from(rich.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	assert.deepEqual(runs.map(run => run.textContent), ["H", "ell", "o"]);
	assert.equal(runs[1]?.classList.contains("stanza-document-mark-strong"), true);

	runs[1]!.textContent = "ELl";
	runs[1]!.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.getDocument().content[0]?.content[1]?.text, "ELl");
	assert.equal(pane.getDocument().content[0]?.content[1]?.marks[0]?.type, "strong");

	runs = Array.from(rich.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	const selection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(runs[0]!.firstChild!, 0);
	range.setEnd(runs[2]!.firstChild!, 1);
	selection?.removeAllRanges();
	selection?.addRange(range);
	const event = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "b", ctrlKey: true });
	rich.dispatchEvent(event);
	assert.equal(event.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.marks.map(mark => mark.type)), [["strong"], ["strong"], ["strong"]]);

	runs = Array.from(rich.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	range.setStart(runs[0]!.firstChild!, 0);
	range.setEnd(runs[2]!.firstChild!, 1);
	selection?.removeAllRanges();
	selection?.addRange(range);
	rich.dispatchEvent(new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "b", ctrlKey: true }));
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.marks), [[], [], []]);

	runs = Array.from(rich.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	range.setStart(runs[0]!.firstChild!, 1);
	range.setEnd(runs[2]!.firstChild!, 0);
	selection?.removeAllRanges();
	selection?.addRange(range);
	const beforeInput = new environment.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "X" });
	rich.dispatchEvent(beforeInput);
	assert.equal(beforeInput.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.text), ["H", "X", "o"]);
	environment.window.close();
});

test("Stanza carries collapsed mark toggles into later input", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(new MemoryTextFiles("Hello"));
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const textarea = parent.querySelector<HTMLTextAreaElement>("textarea.stanza-document-text-input");
	assert.ok(textarea);
	textarea.focus();
	textarea.setSelectionRange(5, 5);
	textarea.dispatchEvent(new environment.window.Event("select", { bubbles: true }));
	const toggle = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "b", ctrlKey: true });
	textarea.dispatchEvent(toggle);
	assert.equal(toggle.defaultPrevented, true);

	textarea.value = "Hello!";
	textarea.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	let rich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(rich);
	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "Hello!");
	assert.deepEqual(pane.getDocument().content[0]?.content[0]?.marks, [{ type: "strong", attrs: {} }]);

	const run = rich.querySelector<HTMLElement>("[data-text-node-id]");
	assert.ok(run?.firstChild);
	const domSelection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(run.firstChild, run.textContent?.length ?? 0);
	range.collapse(true);
	domSelection?.removeAllRanges();
	domSelection?.addRange(range);
	rich.dispatchEvent(new environment.window.Event("focus", { bubbles: true }));
	const off = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "b", ctrlKey: true });
	rich.dispatchEvent(off);
	assert.equal(off.defaultPrevented, true);

	const beforeInput = new environment.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: "?" });
	rich.dispatchEvent(beforeInput);
	assert.equal(beforeInput.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "Hello!?");
	assert.deepEqual(pane.getDocument().content[0]?.content[0]?.marks, []);
	environment.window.close();
});

test("Stanza applies, updates, and removes link marks", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	let promptValue = " https://example.test ";
	Object.defineProperty(environment.window, "prompt", { configurable: true, value: () => promptValue });
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "Hello" },
					{ id: "text-2", type: "text", attrs: {}, content: [], marks: [{ type: "strong", attrs: {} }], text: " world" },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const rich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(rich);
	rich.focus();
	const select = (startRunIndex: number, startOffset: number, endRunIndex: number, endOffset: number): void => {
		const runs = Array.from(rich.querySelectorAll<HTMLElement>("[data-text-node-id]"));
		const selection = environment.window.document.getSelection();
		const range = environment.window.document.createRange();
		range.setStart(runs[startRunIndex]!.firstChild!, startOffset);
		range.setEnd(runs[endRunIndex]!.firstChild!, endOffset);
		selection?.removeAllRanges();
		selection?.addRange(range);
		rich.dispatchEvent(new environment.window.Event("mouseup", { bubbles: true }));
	};

	select(0, 1, 1, 6);
	documentAction(parent, "link").click();
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.marks.map(mark => mark.type)), [[], ["link"], ["strong", "link"]]);
	let links = Array.from(rich.querySelectorAll<HTMLAnchorElement>("a.stanza-document-inline-run"));
	assert.deepEqual(links.map(link => link.getAttribute("href")), ["https://example.test", "https://example.test"]);
	assert.equal(documentAction(parent, "link").classList.contains("checked"), true);

	promptValue = "https://updated.test";
	select(1, 0, 2, 6);
	const shortcut = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "k", ctrlKey: true });
	rich.dispatchEvent(shortcut);
	assert.equal(shortcut.defaultPrevented, true);
	links = Array.from(rich.querySelectorAll<HTMLAnchorElement>("a.stanza-document-inline-run"));
	assert.deepEqual(links.map(link => link.getAttribute("href")), ["https://updated.test", "https://updated.test"]);

	select(1, 0, 2, 6);
	documentAction(parent, "unlink").click();
	assert.equal(rich.querySelectorAll("a.stanza-document-inline-run").length, 0);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.marks.map(mark => mark.type)), [[], [], ["strong"]]);
	environment.window.close();
});

test("Stanza routes rich-text copy and cut through Stanza", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "Hello" },
					{ id: "text-2", type: "text", attrs: {}, content: [], marks: [{ type: "strong", attrs: {} }], text: " world" },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const rich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(rich);
	const runs = Array.from(rich.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	const selection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(runs[0]!.firstChild!, 0);
	range.setEnd(runs[1]!.firstChild!, runs[1]!.textContent!.length);
	selection?.removeAllRanges();
	selection?.addRange(range);
	environment.window.document.dispatchEvent(new environment.window.Event("selectionchange"));

	const clipboardValues = new Map<string, string>();
	const clipboardData = { setData: (type: string, value: string) => clipboardValues.set(type, value) } as unknown as DataTransfer;
	const copy = new environment.window.Event("copy", { bubbles: true, cancelable: true });
	Object.defineProperty(copy, "clipboardData", { value: clipboardData });
	rich.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, true);
	assert.equal(clipboardValues.get("text/plain"), "Hello world");
	const encodedFragment = clipboardValues.get(DOCUMENT_FRAGMENT_CLIPBOARD_MIME);
	assert.ok(encodedFragment);
	assert.equal(pane.getDocument().content[0]?.content.length, 2);

	const pasteSelection = environment.window.document.getSelection();
	const pasteRange = environment.window.document.createRange();
	pasteRange.setStart(runs[1]!.firstChild!, runs[1]!.textContent!.length);
	pasteRange.collapse(true);
	pasteSelection?.removeAllRanges();
	pasteSelection?.addRange(pasteRange);
	environment.window.document.dispatchEvent(new environment.window.Event("selectionchange"));
	const pasteData = {
		files: [],
		items: [],
		getData: (type: string) => type === DOCUMENT_FRAGMENT_CLIPBOARD_MIME ? encodedFragment : "",
	} as unknown as DataTransfer;
	const paste = new environment.window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: pasteData });
	rich.dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content[0]?.content.filter(node => node.text !== undefined).map(node => node.text), ["Hello", " world", "Hello", " world"]);

	const updatedRich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(updatedRich);
	const updatedRuns = Array.from(updatedRich.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	const cutSelection = environment.window.document.getSelection();
	const cutRange = environment.window.document.createRange();
	cutRange.setStart(updatedRuns[0]!.firstChild!, 0);
	cutRange.setEnd(updatedRuns.at(-1)!.firstChild!, updatedRuns.at(-1)!.textContent!.length);
	cutSelection?.removeAllRanges();
	cutSelection?.addRange(cutRange);
	environment.window.document.dispatchEvent(new environment.window.Event("selectionchange"));
	const cut = new environment.window.Event("cut", { bubbles: true, cancelable: true });
	Object.defineProperty(cut, "clipboardData", { value: clipboardData });
	updatedRich.dispatchEvent(cut);
	assert.equal(cut.defaultPrevented, true);
	assert.equal(pane.getDocument().content[0]?.content.length, 0);
	environment.window.close();
});

test("Stanza pastes external HTML through a schema-valid structured fragment", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "Start" },
					{ id: "text-2", type: "text", attrs: {}, content: [], marks: [{ type: "strong", attrs: {} }], text: "End" },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const rich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	const firstRun = rich?.querySelector<HTMLElement>("[data-text-node-id='text-1']");
	assert.ok(rich);
	assert.ok(firstRun);
	const selection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(firstRun.firstChild!, firstRun.textContent!.length);
	range.collapse(true);
	selection?.removeAllRanges();
	selection?.addRange(range);
	environment.window.document.dispatchEvent(new environment.window.Event("selectionchange"));

	const clipboardData = {
		files: [],
		items: [],
		getData: (type: string) => type === "text/html"
			? "<h2>Imported</h2><ul><li><strong>Listed</strong></li></ul><table><tr><td>Cell</td></tr></table>"
			: type === "text/plain" ? "Imported\nListed\nCell" : "",
	} as unknown as DataTransfer;
	const paste = new environment.window.Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(paste, "clipboardData", { value: clipboardData });
	rich.dispatchEvent(paste);

	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content.map(node => node.type), ["paragraph", "heading", "bulletList", "table", "paragraph"]);
	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "Start");
	assert.equal(pane.getDocument().content[1]?.content[0]?.text, "Imported");
	assert.equal(pane.getDocument().content[2]?.content[0]?.content[0]?.content[0]?.text, "Listed");
	assert.equal(pane.getDocument().content[3]?.content[0]?.content[0]?.content[0]?.content[0]?.text, "Cell");
	assert.equal(pane.getDocument().content[4]?.content[0]?.text, "End");
	environment.window.close();
});

test("Stanza handles whole-document select all, copy, and cut", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [
				{
					id: "paragraph-1",
					type: "paragraph",
					attrs: {},
					content: [{ id: "text-1", type: "text", attrs: {}, content: [], marks: [{ type: "strong", attrs: {} }], text: "First" }],
					marks: [],
				},
				{
					id: "paragraph-2",
					type: "paragraph",
					attrs: {},
					content: [{ id: "text-2", type: "text", attrs: {}, content: [], marks: [{ type: "em", attrs: {} }], text: "Second" }],
					marks: [],
				},
			],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const rich = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(rich);
	const selectAll = new environment.window.KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true, cancelable: true });
	rich.dispatchEvent(selectAll);
	assert.equal(selectAll.defaultPrevented, true);

	const clipboardValues = new Map<string, string>();
	const clipboardData = { setData: (type: string, value: string) => clipboardValues.set(type, value) } as unknown as DataTransfer;
	const copy = new environment.window.Event("copy", { bubbles: true, cancelable: true });
	Object.defineProperty(copy, "clipboardData", { value: clipboardData });
	rich.dispatchEvent(copy);
	assert.equal(copy.defaultPrevented, true);
	assert.equal(clipboardValues.get("text/plain"), "First\nSecond");
	assert.ok(clipboardValues.get(DOCUMENT_FRAGMENT_CLIPBOARD_MIME));

	const cut = new environment.window.Event("cut", { bubbles: true, cancelable: true });
	Object.defineProperty(cut, "clipboardData", { value: clipboardData });
	rich.dispatchEvent(cut);
	assert.equal(cut.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content.map(node => node.type), ["paragraph"]);
	assert.equal(pane.getDocument().content[0]?.content.length, 0);
	environment.window.close();
});

test("Stanza replaces a rich-text selection spanning sibling blocks", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [
				{
					id: "paragraph-1",
					type: "paragraph",
					attrs: {},
					content: [
						{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "First" },
						{ id: "break-1", type: "hardBreak", attrs: {}, content: [], marks: [] },
					],
					marks: [],
				},
				{
					id: "paragraph-2",
					type: "paragraph",
					attrs: {},
					content: [
						{ id: "text-2", type: "text", attrs: {}, content: [], marks: [], text: "Second" },
						{ id: "break-2", type: "hardBreak", attrs: {}, content: [], marks: [] },
					],
					marks: [],
				},
			],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const editors = Array.from(parent.querySelectorAll<HTMLDivElement>(".stanza-document-rich-text-input"));
	assert.equal(editors.length, 2);
	const startRun = editors[0]!.querySelector<HTMLElement>("[data-text-node-id='text-1']");
	const endRun = editors[1]!.querySelector<HTMLElement>("[data-text-node-id='text-2']");
	assert.ok(startRun);
	assert.ok(endRun);
	editors[0]!.focus();
	const domSelection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(startRun.firstChild!, 2);
	range.setEnd(endRun.firstChild!, 3);
	domSelection?.removeAllRanges();
	domSelection?.addRange(range);
	environment.window.document.dispatchEvent(new environment.window.Event("selectionchange"));

	const beforeInput = new environment.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
	editors[0]!.dispatchEvent(beforeInput);
	assert.equal(beforeInput.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content.map(node => node.id), ["paragraph-1"]);
	assert.deepEqual(pane.getDocument().content[0]?.content.map(node => node.text ?? node.type), ["Fi", "ond", "hardBreak"]);

	const undo = new environment.window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true });
	(parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input") as HTMLDivElement).dispatchEvent(undo);
	assert.equal(undo.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content.map(node => node.id), ["paragraph-1", "paragraph-2"]);

	const paste = new environment.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: "A\nB" });
	(parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input") as HTMLDivElement).dispatchEvent(paste);
	assert.equal(paste.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content.map(node => node.content.filter(child => child.text !== undefined).map(child => child.text).join("")), ["FiA", "Bond"]);
	environment.window.close();
});

test("Stanza pastes multiline text as structured blocks", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "paragraph-1",
				type: "paragraph",
				attrs: {},
				content: [
					{ id: "text-1", type: "text", attrs: {}, content: [], marks: [], text: "H" },
					{ id: "text-2", type: "text", attrs: {}, content: [], marks: [], text: "ell" },
					{ id: "text-3", type: "text", attrs: {}, content: [], marks: [], text: "o" },
				],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	environment.window.document.body.append(parent);
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const editor = parent.querySelector<HTMLDivElement>(".stanza-document-rich-text-input");
	assert.ok(editor);
	const runs = Array.from(editor.querySelectorAll<HTMLElement>("[data-text-node-id]"));
	const selection = environment.window.document.getSelection();
	const range = environment.window.document.createRange();
	range.setStart(runs[0]!.firstChild!, 1);
	range.setEnd(runs[2]!.firstChild!, 0);
	selection?.removeAllRanges();
	selection?.addRange(range);
	const event = new environment.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertFromPaste", data: "A\nB" });
	editor.dispatchEvent(event);

	assert.equal(event.defaultPrevented, true);
	assert.deepEqual(pane.getDocument().content.map(block => block.content.map(child => child.text ?? "").join("")), ["HA", "Bo"]);
	assert.equal(pane.getDocument().content.length, 2);
	environment.window.close();
});

test("Stanza restores serialized blocks and releases its model", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [
				{
					id: "code-1",
					type: "codeBlock",
					attrs: { language: "typescript" },
					content: [{ id: "code-text-1", type: "text", attrs: {}, content: [], marks: [], text: "const value = 1;" }],
					marks: [],
				},
			],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	assert.equal(parent.querySelector("[data-editor-kind='code-block']")?.textContent, "");
	assert.equal(parent.querySelector<HTMLTextAreaElement>("textarea")?.value, "const value = 1;");
	assert.equal(parent.querySelector<HTMLElement>(".stanza-structured-format-toolbar")?.dataset.context, "code");
	assert.equal(parent.querySelector<HTMLElement>(".stanza-structured-format-code-context")?.textContent, "Code block · Academic");
	assert.equal(parent.querySelector<HTMLElement>(".stanza-structured-format-typography-controls")?.hidden, true);
	pane.clearInput();
	assert.throws(() => pane.getDocument(), /no active model/);
	environment.window.close();
});

test("Stanza edits Academic code-block lines through the owning TextModel", async () => {
	const environment = new JSDOM("<!doctype html><body></body>");
	const files = new MemoryTextFiles(JSON.stringify({
		format: "ash.document",
		version: 1,
		document: {
			id: "document-1",
			type: "doc",
			attrs: {},
			content: [{
				id: "code-1",
				type: "codeBlock",
				attrs: { language: "typescript" },
				content: [{ id: "code-text-1", type: "text", attrs: {}, content: [], marks: [], text: "const value = 1;" }],
				marks: [],
			}],
			marks: [],
		},
	}));
	const parent = h(environment.window.document, "main");
	using pane = new EditorPane(files);
	pane.create(parent);
	await pane.setInput({ resource: URI.file("C:\\project\\paper.ash-academic") }, new AbortController().signal);

	const editor = parent.querySelector<HTMLTextAreaElement>("[data-editor-kind='code-block'] textarea.stanza-document-text-input");
	assert.ok(editor);
	assert.equal(parent.querySelector("[data-editor-kind='code-block'] .stanza-editor"), null);
	editor.value = "const value = 3;";
	editor.dispatchEvent(new environment.window.Event("input", { bubbles: true }));
	assert.equal(pane.getDocument().content[0]?.content[0]?.text, "const value = 3;");
	environment.window.close();
});

async function waitFor(predicate: () => boolean, timeout = 500): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for Stanza browser state");
		await new Promise(resolve => setTimeout(resolve, 1));
	}
}

class MemoryTextFiles implements ITextFileService {
	readonly onDidChangeFiles = (_listener: (event: IFileChangeEvent) => void) => ({
		dispose(): void {},
		[Symbol.dispose](): void {},
	});
	lastSavedText = "";
	private revision = 1;

	constructor(private text: string) {}

	async resolve(request: TextFileResolveRequest, _signal: AbortSignal): Promise<ResolvedTextFileContent> {
		return {
			resource: request.resource,
			text: request.bootstrapText ?? this.text,
			source: request.bootstrapText === undefined ? "fileSystem" as ResolvedTextFileContent["source"] : "bootstrap" as ResolvedTextFileContent["source"],
			revision: request.bootstrapText === undefined ? this.currentRevision() : undefined,
			encoding: "utf8",
		};
	}

	async save(request: TextFileSaveRequest, _signal: AbortSignal): Promise<{ readonly revision: string | undefined }> {
		if (request.expectedRevision !== undefined && request.expectedRevision !== this.currentRevision()) {
			throw new TextFileSaveConflictError(request.resource);
		}
		this.lastSavedText = request.text;
		this.text = request.text;
		this.revision += 1;
		return { revision: this.currentRevision() };
	}

	setExternalText(text: string): void {
		this.text = text;
		this.revision += 1;
	}

	private currentRevision(): string {
		return `revision-${this.revision}`;
	}
}

test('switching a document cancels a pending room and disposes a late connection', async () => {
	const environment = new JSDOM('<!doctype html><body></body>');
	Object.defineProperty(environment.window, 'prompt', { configurable: true, value: () => '' });
	let finishOpen!: () => void;
	const pending = new Promise<void>(resolve => { finishOpen = resolve; });
	let openingSignal: AbortSignal | undefined;
	let disposed = false;
	using pane = new EditorPane(new MemoryTextFiles('First'), {
		createDocumentCollaborationService: () => ({
			dispose() {},
			[Symbol.dispose]() {},
			async open(input, signal) {
				openingSignal = signal;
				await pending;
				return {
					roomId: 'late-room', clientId: input.clientId, principalId: 'owner', canEdit: true, canManageMembers: true,
					schema: input.schema, initialSnapshot: { roomId: 'late-room', version: 0, document: input.document }, currentPresence: [],
					onDidReceiveUpdate: Event.None, onDidReceiveSnapshot: Event.None, onDidReceivePresence: Event.None, onDidFail: Event.None,
					submit: async () => { throw new Error('A stale connection must not submit'); },
					updatePresence: async () => { throw new Error('A stale connection must not publish presence'); },
					createInvite: async () => { throw new Error('A stale connection must not invite'); },
					listMembers: async () => [],
					rotateMemberAccessToken: async () => { throw new Error('A stale connection must not rotate credentials'); },
					revokeMember: async () => {},
					dispose: () => { disposed = true; },
					[Symbol.dispose]: () => { disposed = true; },
				};
			},
		}),
	});
	try {
		pane.create(environment.window.document.body);
		await pane.setInput({ resource: URI.file('/first.md') }, new AbortController().signal);
		documentAction(environment.window.document, 'startCollaboration').click();
		assert.equal(openingSignal?.aborted, false);
		await pane.setInput({ resource: URI.file('/second.md') }, new AbortController().signal);
		assert.equal(openingSignal?.aborted, true);
		finishOpen();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.equal(disposed, true);
		assert.equal(environment.window.document.querySelector('.stanza-document-collaboration-toolbar')?.getAttribute('data-state'), 'inactive');
		assert.equal(environment.window.document.querySelector('[data-action-id="inviteCollaborator"]'), null);
	} finally {
		pane.dispose();
		environment.window.close();
	}
});
