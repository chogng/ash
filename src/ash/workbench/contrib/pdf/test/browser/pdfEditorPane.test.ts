import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { type IFileSystemProvider, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { createTestFileService, createTestComponentServices, registerTestComponentServices } from '../../../../test/common/testEditorServices.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { CancellationError } from '../../../../../base/common/errors.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { EditorPaneMatch } from '../../../../../workbench/browser/parts/editor/editorPane.js';
import { PdfEditorPane } from '../../../../../../../extensions/pdf-viewer/browser/pdfEditorPane.js';
import type { IPdfAnnotationStore, PdfAnnotationSnapshot } from '../../../../../../../extensions/pdf-viewer/browser/pdfAnnotationStore.js';
import { WorkspacePdfAnnotationStore } from '../../../../../../../extensions/pdf-viewer/browser/pdfAnnotationStore.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { WorkspacePdfDocumentLoader } from '../../../../../../../extensions/pdf-viewer/browser/pdfDocumentLoader.js';
import type { IPdfRenderResult, IPdfRenderer, PdfRenderRequest } from '../../../../../../../extensions/pdf-viewer/browser/pdfRenderer.js';
import { matchPdfEditor } from '../../../../../../../extensions/pdf-viewer/browser/pdfEditorInput.js';
import { emptyPdfAnnotationDocument, type PdfAnnotationDocument } from '../../../../../../../extensions/pdf-viewer/common/pdfAnnotations.js';
import { addDisposableListener, h } from '../../../../../base/browser/dom.js';

test('PDF editor matching selects only application/pdf and .pdf resources', () => {
	assert.equal(matchPdfEditor(input('paper.PDF')), EditorPaneMatch.Default);
	assert.equal(matchPdfEditor({ ...input('paper.bin'), contentType: 'Application/PDF; charset=binary' }), EditorPaneMatch.Default);
	assert.equal(matchPdfEditor(input('paper.txt')), EditorPaneMatch.None);
});

test('PDF editor renders pages, creates annotations, and saves a companion document', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const annotations = new TestAnnotationStore();
	const renderer = new TestRenderer();
	using services = createTestComponentServices(undefined, undefined, dom.window.document);
	const pane = registerTestComponentServices(services).createInstance(PdfEditorPane, { load: async () => new Uint8Array([37, 80, 68, 70]) }, annotations, renderer);
	pane.create(dom.window.document.body);

	await pane.setInput(input('paper.pdf'), new AbortController().signal);
	const reader = dom.window.document.querySelector<HTMLElement>('.ash-pdf-editor');
	const pages = dom.window.document.querySelector<HTMLElement>('.ash-pdf-pages');
	const page = dom.window.document.querySelector<HTMLElement>('.ash-pdf-page');
	let layer = dom.window.document.querySelector<HTMLElement>('.ash-pdf-annotation-layer');
	assert.ok(reader);
	assert.ok(pages);
	assert.ok(page);
	assert.ok(layer);
	assert.equal(page.querySelectorAll('.ash-pdf-page-canvas').length, 1);
	assert.equal(renderer.requests.length, 1);

	actionButton(dom, 'ash.pdf.annotations.highlight').click();
	layer = dom.window.document.querySelector<HTMLElement>('.ash-pdf-annotation-layer');
	assert.ok(layer);
	setLayerBounds(layer);
	layer.dispatchEvent(pointer(dom, 'pointerdown', 24, 36));
	layer.dispatchEvent(pointer(dom, 'pointermove', 180, 90));
	layer.dispatchEvent(pointer(dom, 'pointerup', 180, 90));

	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-highlight').length, 1);
	assert.match(dom.window.document.querySelector('.ash-pdf-annotation-status')?.textContent ?? '', /Unsaved/);
	assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, false);
	await pane.save();
	assert.equal(annotations.saved.length, 1);
	assert.equal(annotations.saved[0]?.document.annotations[0]?.kind, 'highlight');
	assert.match(dom.window.document.querySelector('.ash-pdf-annotation-status')?.textContent ?? '', /saved/);

	actionButton(dom, 'ash.pdf.annotations.ink').click();
	layer = dom.window.document.querySelector<HTMLElement>('.ash-pdf-annotation-layer');
	assert.ok(layer);
	setLayerBounds(layer);
	layer.dispatchEvent(pointer(dom, 'pointerdown', 42, 36));
	layer.dispatchEvent(pointer(dom, 'pointermove', 108, 72));
	layer.dispatchEvent(pointer(dom, 'pointerup', 180, 96));
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-ink').length, 1);

	actionButton(dom, 'ash.pdf.annotations.note').click();
	layer = dom.window.document.querySelector<HTMLElement>('.ash-pdf-annotation-layer');
	assert.ok(layer);
	setLayerBounds(layer);
	layer.dispatchEvent(pointer(dom, 'pointerdown', 210, 60));
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 1);
	actionButton(dom, 'ash.pdf.annotations.delete').click();
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 0);
	actionButton(dom, 'ash.pdf.annotations.undo').click();
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 1);
	actionButton(dom, 'ash.pdf.annotations.redo').click();
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 0);

	pane.setVisible(false);
	assert.equal(reader.hidden, true);
	pane.setVisible(true);
	pane.focus();
	assert.equal(dom.window.document.activeElement, pages);
	pane.clearInput();
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-page').length, 0);
	assert.equal(renderer.disposed, 1);
	pane.dispose();
	dom.window.close();
});

test('PDF editor observes cancellation before rendering pages', async () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	const renderer = new TestRenderer();
	using services = createTestComponentServices(undefined, undefined, dom.window.document);
	const pane = registerTestComponentServices(services).createInstance(PdfEditorPane, { load: async () => new Uint8Array([37]) }, new TestAnnotationStore(), renderer);
	pane.create(dom.window.document.body);
	const controller = new AbortController();
	controller.abort('closed');

	await assert.rejects(pane.setInput(input('paper.pdf'), controller.signal), CancellationError);
	assert.equal(renderer.requests.length, 0);
	pane.dispose();
	dom.window.close();
});

test('PDF reading shortcuts precede document commands only while the pane is focused', async () => {
	const dom = new JSDOM('<!doctype html><body><button id="outside">Outside</button></body>');
	using services = createTestComponentServices(undefined, undefined, dom.window.document);
	using pane = registerTestComponentServices(services).createInstance(PdfEditorPane, { load: async () => new Uint8Array([37]) }, new TestAnnotationStore(), new TestRenderer());
	pane.create(dom.window.document.body);
	await pane.setInput(input('paper.pdf'), new AbortController().signal);
	let globalKeys = 0;
	using globalListener = addDisposableListener(dom.window.document, 'keydown', () => { globalKeys++; }, true);
	const pages = dom.window.document.querySelector<HTMLElement>('.ash-pdf-pages')!;
	const zoom = dom.window.document.querySelector<HTMLSelectElement>('.ash-pdf-zoom')!;
	const key = () => new dom.window.KeyboardEvent('keydown', { key: '0', metaKey: true, bubbles: true, cancelable: true });
	pages.focus();
	pages.dispatchEvent(key());
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(zoom.value, '1');
	assert.equal(globalKeys, 0);
	const outside = dom.window.document.getElementById('outside')!;
	outside.focus();
	outside.dispatchEvent(key());
	assert.equal(globalKeys, 1);
	pane.dispose();
	pages.dispatchEvent(key());
	outside.dispatchEvent(key());
	assert.equal(globalKeys, 2);
	dom.window.close();
});

for (const change of ['add', 'update', 'delete', 'undo', 'redo'] as const) {
	test(`PDF editor retains ${change} during a delayed save and persists it with the next revision`, async () => {
		using fixture = await createSavingFixture();
		const { dom, pane, annotations } = fixture;
		addNote(dom);
		if (change === 'redo') {
			addNote(dom);
			actionButton(dom, 'ash.pdf.annotations.undo').click();
		}
		const pending = pane.save();
		assert.equal(annotations.requests.length, 1);
		const duplicate = pane.save();
		assert.equal(annotations.requests.length, 1);
		if (change === 'add') addNote(dom);
		if (change === 'update') {
			const text = dom.window.document.querySelector<HTMLTextAreaElement>('.ash-pdf-annotation-text')!;
			assert.equal(text.disabled, false);
			text.value = 'Edited while saving';
			text.dispatchEvent(new dom.window.Event('change'));
		}
		if (change === 'delete') actionButton(dom, 'ash.pdf.annotations.delete').click();
		if (change === 'undo') actionButton(dom, 'ash.pdf.annotations.undo').click();
		if (change === 'redo') actionButton(dom, 'ash.pdf.annotations.redo').click();
		assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
		const items = () => [...dom.window.document.querySelectorAll('.ash-pdf-annotation-list-item')].map(item => item.textContent);
		const edited = items();
		const expectedCounts = { add: 2, update: 1, delete: 0, undo: 0, redo: 2 };
		assert.equal(edited.length, expectedCounts[change]);
		const history = { undo: actionButton(dom, 'ash.pdf.annotations.undo').disabled, redo: actionButton(dom, 'ash.pdf.annotations.redo').disabled };
		await annotations.complete(0);
		await Promise.all([pending, duplicate]);
		assert.deepEqual(items(), edited);
		assert.deepEqual({ undo: actionButton(dom, 'ash.pdf.annotations.undo').disabled, redo: actionButton(dom, 'ash.pdf.annotations.redo').disabled }, history);
		assert.match(dom.window.document.querySelector('.ash-pdf-annotation-status')!.textContent!, /Unsaved annotations/);
		assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, false);
		actionButton(dom, change === 'undo' ? 'ash.pdf.annotations.redo' : 'ash.pdf.annotations.undo').click();
		assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
		actionButton(dom, change === 'undo' ? 'ash.pdf.annotations.undo' : 'ash.pdf.annotations.redo').click();
		assert.deepEqual(items(), edited);
		const second = pane.save();
		assert.equal(annotations.requests[1].expectedRevision, 'revision-1');
		assert.equal(annotations.requests[1].document.annotations.length, edited.length);
		if (change === 'update') assert.equal(annotations.requests[1].document.annotations[0].kind === 'note' && annotations.requests[1].document.annotations[0].text, 'Edited while saving');
		await annotations.complete(1);
		await second;
		assert.deepEqual(items(), edited);
		assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
		assert.equal(dom.window.document.querySelector('.ash-pdf-annotation-status')!.textContent, 'Annotations saved');
	});
}

test('PDF editor acknowledges a delayed save without intervening edits', async () => {
	using fixture = await createSavingFixture();
	const { dom, pane, annotations } = fixture;
	addNote(dom);
	const pending = pane.save();
	assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
	await annotations.complete(0);
	await pending;
	assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
	assert.equal(dom.window.document.querySelector('.ash-pdf-annotation-status')!.textContent, 'Annotations saved');
	actionButton(dom, 'ash.pdf.annotations.undo').click();
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 0);
	assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, false);
	actionButton(dom, 'ash.pdf.annotations.redo').click();
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 1);
	assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
});

test('PDF editor keeps edits and the previous revision after a failed save, then retries', async () => {
	using fixture = await createSavingFixture();
	const { dom, pane, annotations } = fixture;
	addNote(dom);
	const pending = assert.rejects(pane.save(), /write failed/);
	addNote(dom);
	await annotations.requests[0].result.error(new Error('write failed'));
	await pending;
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 2);
	assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, false);
	assert.match(dom.window.document.querySelector('.ash-pdf-annotation-status')!.textContent!, /Could not save annotations: write failed/);
	const retry = pane.save();
	assert.equal(annotations.requests[1].expectedRevision, 'initial');
	assert.equal(annotations.requests[1].document.annotations.length, 2);
	await annotations.complete(1);
	await retry;
	assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
	assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, 2);
});

for (const transition of ['switch', 'reopen', 'close', 'retire'] as const) {
	for (const outcome of ['success', 'failure'] as const) {
		test(`PDF editor ignores a delayed ${outcome} after input ${transition}`, async () => {
			using fixture = await createSavingFixture();
			const { dom, pane, annotations, provider, resourceInput } = fixture;
			addNote(dom);
			const pending = assert.rejects(pane.save(), outcome === 'success' ? CancellationError : /old write failed/);
			if (transition === 'retire') {
				addNote(dom);
				provider.abort();
			} else {
				pane.clearInput();
			}
			assert.equal(annotations.requests[0].signal.aborted, true);
			let next: Promise<void> | undefined;
			if (transition === 'switch' || transition === 'reopen') {
				await pane.setInput(transition === 'switch' ? input('other.pdf') : resourceInput, new AbortController().signal);
				addNote(dom);
				next = pane.save();
				assert.equal(annotations.requests.length, 2, 'The new input can save independently of the cancelled request');
			}
			const status = dom.window.document.querySelector('.ash-pdf-annotation-status')!.textContent;
			if (outcome === 'success') await annotations.complete(0);
			else await annotations.requests[0].result.error(new Error('old write failed'));
			await pending;
			assert.equal(dom.window.document.querySelector('.ash-pdf-annotation-status')!.textContent, status);
			const expectedCounts = { switch: 1, reopen: 1, close: 0, retire: 2 };
			assert.equal(dom.window.document.querySelectorAll('.ash-pdf-annotation-note').length, expectedCounts[transition]);
			assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, true);
			if (next) {
				const duplicate = pane.save();
				assert.equal(annotations.requests.length, 2);
				await annotations.complete(1);
				await Promise.all([next, duplicate]);
				assert.equal(annotations.requests[1].expectedRevision, 'initial');
			}
		});
	}
}

interface SavingFixture extends IDisposable {
	readonly dom: JSDOM;
	readonly pane: PdfEditorPane;
	readonly annotations: DelayedAnnotationStore;
	readonly provider: AbortController;
	readonly resourceInput: IResourceEditorInput;
}

for (const concurrent of [false, true]) {
	test(`PDF windows preserve the rejected first-save draft and its undo history (${concurrent ? 'concurrent' : 'sequential'})`, async () => {
		using memory = new InMemoryFileSystemProvider();
		await memory.createDirectory(URI.file('/workspace'));
		const resource = URI.file('/workspace/paper.pdf');
		using files = createTestFileService(memory);
		const doms = [new JSDOM('<!doctype html><body></body>'), new JSDOM('<!doctype html><body></body>')];
		using firstServices = createTestComponentServices(undefined, undefined, doms[0].window.document);
		using secondServices = createTestComponentServices(undefined, undefined, doms[1].window.document);
		const panes = [firstServices, secondServices].map(services => registerTestComponentServices(services).createInstance(PdfEditorPane, { load: async () => new Uint8Array([37]) }, new WorkspacePdfAnnotationStore(files), new TestRenderer()));
		try {
			for (let index = 0; index < panes.length; index++) {
				panes[index].create(doms[index].window.document.body);
				await panes[index].setInput({ resource }, new AbortController().signal);
				addNote(doms[index]);
				const text = doms[index].window.document.querySelector<HTMLTextAreaElement>('.ash-pdf-annotation-text')!;
				text.value = `Window ${index}`;
				text.dispatchEvent(new doms[index].window.Event('change'));
			}
			const results = concurrent ? await Promise.allSettled(panes.map(pane => pane.save())) : [await panes[0].save().then(() => ({ status: 'fulfilled' as const })), ...await Promise.allSettled([panes[1].save()])];
			assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
			const loser = results.findIndex(result => result.status === 'rejected');
			const rejected = results[loser];
			assert.ok(rejected.status === 'rejected');
			assert.equal(toFileSystemProviderErrorCode(rejected.reason), FileSystemProviderErrorCode.FileExists);
			const dom = doms[loser];
			const items = () => [...dom.window.document.querySelectorAll('.ash-pdf-annotation-list-item')].map(item => item.textContent);
			assert.deepEqual(items(), [`Note 1: Window ${loser}`]);
			assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, false);
			assert.match(dom.window.document.querySelector('.ash-pdf-annotation-status')!.textContent!, /Could not save annotations/);
			actionButton(dom, 'ash.pdf.annotations.undo').click();
			actionButton(dom, 'ash.pdf.annotations.redo').click();
			assert.deepEqual(items(), [`Note 1: Window ${loser}`]);
			const store = new WorkspacePdfAnnotationStore(files);
			const persisted = await store.load(resource, new AbortController().signal);
			await assert.rejects(panes[loser].save(), error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileExists);
			assert.deepEqual(items(), [`Note 1: Window ${loser}`]);
			assert.equal(actionButton(dom, 'ash.pdf.annotations.save').disabled, false);
			assert.deepEqual(await store.load(resource, new AbortController().signal), persisted);
		} finally { for (const pane of panes) pane.dispose(); for (const dom of doms) dom.window.close(); }
	});
}

async function createSavingFixture(): Promise<SavingFixture> {
	const dom = new JSDOM('<!doctype html><body></body>');
	const annotations = new DelayedAnnotationStore();
	const services = createTestComponentServices(undefined, undefined, dom.window.document);
	const pane = registerTestComponentServices(services).createInstance(PdfEditorPane, { load: async () => new Uint8Array([37]) }, annotations, new TestRenderer());
	const provider = new AbortController();
	pane.bindProvider(provider.signal);
	pane.create(dom.window.document.body);
	const resourceInput = input('paper.pdf');
	await pane.setInput(resourceInput, new AbortController().signal);
	const dispose = () => { pane.dispose(); services.dispose(); dom.window.close(); };
	return { dom, pane, annotations, provider, resourceInput, dispose, [Symbol.dispose]: dispose };
}

function addNote(dom: JSDOM): void {
	actionButton(dom, 'ash.pdf.annotations.note').click();
	const layer = dom.window.document.querySelector<HTMLElement>('.ash-pdf-annotation-layer')!;
	setLayerBounds(layer);
	layer.dispatchEvent(pointer(dom, 'pointerdown', 100, 60));
}

class DelayedAnnotationStore implements IPdfAnnotationStore {
	readonly requests: { readonly resource: URI; readonly document: PdfAnnotationDocument; readonly expectedRevision: string | undefined; readonly signal: AbortSignal; readonly result: DeferredPromise<PdfAnnotationSnapshot>; }[] = [];

	async load(): Promise<PdfAnnotationSnapshot> {
		return { document: emptyPdfAnnotationDocument(), revision: 'initial' };
	}

	save(resource: URI, document: PdfAnnotationDocument, expectedRevision: string | undefined, signal: AbortSignal): Promise<PdfAnnotationSnapshot> {
		const result = new DeferredPromise<PdfAnnotationSnapshot>();
		this.requests.push({ resource, document, expectedRevision, signal, result });
		return result.p;
	}

	async complete(index: number): Promise<void> {
		const request = this.requests[index];
		await request.result.complete({ document: request.document, revision: `revision-${index + 1}` });
	}
}

test('workspace PDF loader reads only through the binary file contract', async () => {
	const resource = URI.file('C:\\project\\paper.pdf');
	using fileService = createTestFileService({
		capabilities: FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy,
		onDidChangeCapabilities: Event.None,
		watch: (): IDisposable => Disposable.None,

		onDidChangeFiles: () => ({ dispose() { }, [Symbol.dispose]() { } }),
		stat: async () => ({ resource, kind: FileKind.File, sizeBytes: 4, readonly: true, modifiedAtMillis: undefined }),
		readDirectory: async () => [],
		readFile: async (requested) => ({ resource: requested, bytes: new Uint8Array([37, 80, 68, 70]), revision: 'pdf-revision' }),
		writeFile: async () => { throw new Error('PDF loader is read-only'); },
		createFile: async () => { throw new Error('PDF loader is read-only'); },
		createDirectory: async () => { throw new Error('PDF loader is read-only'); },
		copy: async () => { throw new Error('Copy is not used in this test'); },
		rename: async () => { throw new Error('PDF loader is read-only'); },
		delete: async () => { throw new Error('PDF loader is read-only'); },
	} satisfies IFileSystemProvider);
	const loader = new WorkspacePdfDocumentLoader(fileService);

	assert.deepEqual(await loader.load(input('paper.pdf'), new AbortController().signal), new Uint8Array([37, 80, 68, 70]));
});

function input(name: string): IResourceEditorInput {
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
	Object.defineProperty(layer, 'getBoundingClientRect', {
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
		const page = h(request.container.ownerDocument, 'div');
		page.className = 'ash-pdf-page';
		const canvas = h(request.container.ownerDocument, 'canvas');
		canvas.className = 'ash-pdf-page-canvas';
		page.append(canvas);
		request.container.append(page);
		return {
			pages: [{ pageNumber: 1, element: page, width: 300, height: 144, text: '', textRuns: [] }],
			scale: request.scale,
			setScale: async () => { },
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
