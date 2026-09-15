import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { CancellationError } from "../../../../../base/common/errors.js";
import { URI } from "../../../../../base/common/uri.js";
import { FileKind, type IFileService } from "../../../../../platform/files/common/files.js";
import type { EditorInput } from "../../../../../workbench/browser/parts/editor/editorInput.js";
import { EditorPaneMatch, EditorPaneVisibility } from "../../../../../workbench/browser/parts/editor/editorPane.js";
import { PdfEditorPane } from "../../../../../workbench/contrib/pdf/browser/pdfEditorPane.js";
import type { IPdfAnnotationStore, PdfAnnotationSnapshot } from "../../../../../workbench/contrib/pdf/browser/pdfAnnotationStore.js";
import { WorkspacePdfDocumentLoader } from "../../../../../workbench/contrib/pdf/browser/pdfDocumentLoader.js";
import type { IPdfRenderResult, IPdfRenderer, PdfRenderRequest } from "../../../../../workbench/contrib/pdf/browser/pdfRenderer.js";
import { matchPdfEditor } from "../../../../../workbench/contrib/pdf/browser/pdfEditorInput.js";
import { emptyPdfAnnotationDocument, type PdfAnnotationDocument } from "../../../../../workbench/contrib/pdf/common/pdfAnnotations.js";
import { h } from "../../../../../base/browser/dom.js";

test("PDF editor matching selects only application/pdf and .pdf resources", () => {
	assert.equal(matchPdfEditor(input("paper.PDF")), EditorPaneMatch.Default);
	assert.equal(matchPdfEditor({ ...input("paper.bin"), contentType: "Application/PDF; charset=binary" }), EditorPaneMatch.Default);
	assert.equal(matchPdfEditor(input("paper.txt")), EditorPaneMatch.None);
});

test("PDF editor renders pages, creates annotations, and saves a companion document", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const annotations = new TestAnnotationStore();
	const renderer = new TestRenderer();
	const pane = new PdfEditorPane({ load: async () => new Uint8Array([37, 80, 68, 70]) }, annotations, renderer);
	pane.create(dom.window.document.body);

	await pane.setInput(input("paper.pdf"), new AbortController().signal);
	const reader = dom.window.document.querySelector<HTMLElement>(".ash-pdf-editor");
	const pages = dom.window.document.querySelector<HTMLElement>(".ash-pdf-pages");
	const page = dom.window.document.querySelector<HTMLElement>(".ash-pdf-page");
	let layer = dom.window.document.querySelector<HTMLElement>(".ash-pdf-annotation-layer");
	assert.ok(reader);
	assert.ok(pages);
	assert.ok(page);
	assert.ok(layer);
	assert.equal(page.querySelectorAll(".ash-pdf-page-canvas").length, 1);
	assert.equal(renderer.requests.length, 1);

	actionButton(dom, "ash.pdf.annotations.highlight").click();
	layer = dom.window.document.querySelector<HTMLElement>(".ash-pdf-annotation-layer");
	assert.ok(layer);
	setLayerBounds(layer);
	layer.dispatchEvent(pointer(dom, "pointerdown", 24, 36));
	layer.dispatchEvent(pointer(dom, "pointermove", 180, 90));
	layer.dispatchEvent(pointer(dom, "pointerup", 180, 90));

	assert.equal(dom.window.document.querySelectorAll(".ash-pdf-annotation-highlight").length, 1);
	assert.match(dom.window.document.querySelector(".ash-pdf-annotation-status")?.textContent ?? "", /Unsaved/);
	assert.equal(actionButton(dom, "ash.pdf.annotations.save").disabled, false);
	await pane.save();
	assert.equal(annotations.saved.length, 1);
	assert.equal(annotations.saved[0]?.document.annotations[0]?.kind, "highlight");
	assert.match(dom.window.document.querySelector(".ash-pdf-annotation-status")?.textContent ?? "", /saved/);

	actionButton(dom, "ash.pdf.annotations.ink").click();
	layer = dom.window.document.querySelector<HTMLElement>(".ash-pdf-annotation-layer");
	assert.ok(layer);
	setLayerBounds(layer);
	layer.dispatchEvent(pointer(dom, "pointerdown", 42, 36));
	layer.dispatchEvent(pointer(dom, "pointermove", 108, 72));
	layer.dispatchEvent(pointer(dom, "pointerup", 180, 96));
	assert.equal(dom.window.document.querySelectorAll(".ash-pdf-annotation-ink").length, 1);

	actionButton(dom, "ash.pdf.annotations.note").click();
	layer = dom.window.document.querySelector<HTMLElement>(".ash-pdf-annotation-layer");
	assert.ok(layer);
	setLayerBounds(layer);
	layer.dispatchEvent(pointer(dom, "pointerdown", 210, 60));
	assert.equal(dom.window.document.querySelectorAll(".ash-pdf-annotation-note").length, 1);
	actionButton(dom, "ash.pdf.annotations.delete").click();
	assert.equal(dom.window.document.querySelectorAll(".ash-pdf-annotation-note").length, 0);
	actionButton(dom, "ash.pdf.annotations.undo").click();
	assert.equal(dom.window.document.querySelectorAll(".ash-pdf-annotation-note").length, 1);
	actionButton(dom, "ash.pdf.annotations.redo").click();
	assert.equal(dom.window.document.querySelectorAll(".ash-pdf-annotation-note").length, 0);

	pane.setVisible(EditorPaneVisibility.Hidden);
	assert.equal(reader.hidden, true);
	pane.setVisible(EditorPaneVisibility.Visible);
	pane.focus();
	assert.equal(dom.window.document.activeElement, pages);
	pane.clearInput();
	assert.equal(dom.window.document.querySelectorAll(".ash-pdf-page").length, 0);
	assert.equal(renderer.disposed, 1);
	pane.dispose();
	dom.window.close();
});

test("PDF editor observes cancellation before rendering pages", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const renderer = new TestRenderer();
	const pane = new PdfEditorPane({ load: async () => new Uint8Array([37]) }, new TestAnnotationStore(), renderer);
	pane.create(dom.window.document.body);
	const controller = new AbortController();
	controller.abort("closed");

	await assert.rejects(pane.setInput(input("paper.pdf"), controller.signal), CancellationError);
	assert.equal(renderer.requests.length, 0);
	pane.dispose();
	dom.window.close();
});

test("workspace PDF loader reads only through the binary file contract", async () => {
	const resource = URI.file("C:\\project\\paper.pdf");
	const loader = new WorkspacePdfDocumentLoader({
		onDidChangeFiles: () => ({ dispose() {}, [Symbol.dispose]() {} }),
		stat: async () => ({ resource, kind: FileKind.File, sizeBytes: 4, readonly: true, modifiedAtMillis: undefined }),
		readDirectory: async () => [],
		readFile: async () => { throw new Error("PDF loader must not request text"); },
		readFileBytes: async (requested) => ({ resource: requested, bytes: new Uint8Array([37, 80, 68, 70]), revision: "pdf-revision" }),
		writeFile: async () => { throw new Error("PDF loader is read-only"); },
		createFile: async () => { throw new Error("PDF loader is read-only"); },
		rename: async () => { throw new Error("PDF loader is read-only"); },
		delete: async () => { throw new Error("PDF loader is read-only"); },
	} satisfies IFileService);

	assert.deepEqual(await loader.load(input("paper.pdf"), new AbortController().signal), new Uint8Array([37, 80, 68, 70]));
});

function input(name: string): EditorInput {
	return { resource: URI.file(`C:\\project\\${name}`), label: name };
}

function actionButton(dom: JSDOM, id: string): HTMLButtonElement {
	const button = dom.window.document.querySelector<HTMLButtonElement>(`[data-action-id="${id}"] button`);
	assert.ok(button, `expected action ${id}`);
	return button;
}

function pointer(dom: JSDOM, type: string, clientX: number, clientY: number): MouseEvent {
	return new dom.window.MouseEvent(type, { bubbles: true, button: 0, clientX, clientY });
}

function setLayerBounds(layer: HTMLElement): void {
	Object.defineProperty(layer, "getBoundingClientRect", {
		value: () => ({ left: 0, top: 0, width: 300, height: 144 }),
	});
}

class TestAnnotationStore implements IPdfAnnotationStore {
	readonly saved: PdfAnnotationSnapshot[] = [];

	async load(): Promise<PdfAnnotationSnapshot> {
		return { document: emptyPdfAnnotationDocument(), revision: undefined };
	}

	async save(_resource: URI, document: PdfAnnotationDocument, _expectedRevision: string | undefined): Promise<PdfAnnotationSnapshot> {
		const snapshot = { document, revision: `revision-${this.saved.length + 1}` };
		this.saved.push(snapshot);
		return snapshot;
	}
}

class TestRenderer implements IPdfRenderer {
	readonly requests: PdfRenderRequest[] = [];
	disposed = 0;

	async render(request: PdfRenderRequest): Promise<IPdfRenderResult> {
		this.requests.push(request);
		const page = h(request.container.ownerDocument, "div");
		page.className = "ash-pdf-page";
		const canvas = h(request.container.ownerDocument, "canvas");
		canvas.className = "ash-pdf-page-canvas";
		page.append(canvas);
		request.container.append(page);
		return {
			pages: [{ pageNumber: 1, element: page, width: 300, height: 144 }],
			pageCount: 1,
			dispose: () => {
				this.disposed += 1;
				page.remove();
			},
			[Symbol.dispose]: () => {
				this.disposed += 1;
				page.remove();
			},
		};
	}
}
