import { DeferredPromise } from '../../../src/ash/base/common/async.js';
import { DisposableStore, toDisposable } from '../../../src/ash/base/common/lifecycle.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { Schemas } from '../../../src/ash/base/common/network.js';
import { FileService } from '../../../src/ash/platform/files/common/fileService.js';
import { FileRevisionConflictError, toFileSystemProviderErrorCode } from '../../../src/ash/platform/files/common/files.js';
import { HTMLFileSystemProvider } from '../../../src/ash/platform/files/browser/htmlFileSystemProvider.js';
import { WorkspacePdfAnnotationStore } from '../../../extensions/pdf-viewer/browser/pdfAnnotationStore.js';
import { parsePdfAnnotationDocument } from '../../../extensions/pdf-viewer/common/pdfAnnotations.js';
import { addDisposableListener } from '../../../src/ash/base/browser/dom.js';

const resources = new DisposableStore();
let browserProvider: HTMLFileSystemProvider;
let folderResource: URI;
let browserFiles: FileService;
let pdfPause: { reached: Promise<void>; release: () => Promise<void>; } | undefined;
const shutdown = addDisposableListener(window, 'pagehide', () => { resources.dispose(); shutdown.dispose(); }, { once: true });
const integration = {
	async prepareBrowserPdf(root?: string): Promise<string> {
		resources.clear();
		browserProvider = resources.add(new HTMLFileSystemProvider(indexedDB, window));
		folderResource = root ? URI.parse(root) : await browserProvider.registerDirectoryHandle(
			await (await navigator.storage.getDirectory()).getDirectoryHandle(`pdf-${crypto.randomUUID()}`, { create: true }));
		browserFiles = resources.add(new FileService());
		resources.add(browserFiles.registerProvider(Schemas.file, browserProvider));
		return folderResource.toString();
	},
	async saveBrowserPdf(text: string, revision?: string): Promise<string> {
		const store = new WorkspacePdfAnnotationStore(browserFiles);
		const document = parsePdfAnnotationDocument(JSON.stringify({ version: 1, annotations: [{
			id: 'note', kind: 'note', page: 1, point: { x: 0.5, y: 0.5 }, text, color: '#f6c945',
			createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
		}] }));
		try {
			await store.save(folderResource.joinPathSegment('paper.pdf'), document, revision, new AbortController().signal);
			return 'saved';
		} catch (error) {
			if (error instanceof FileRevisionConflictError) { return error.name; }
			if (error instanceof Error && error.message === 'Injected write failure') { return error.message; }
			return toFileSystemProviderErrorCode(error as Error);
		}
	},
	async loadBrowserPdf() {
		return new WorkspacePdfAnnotationStore(browserFiles).load(folderResource.joinPathSegment('paper.pdf'), new AbortController().signal);
	},
	async overwriteBrowserSidecar(): Promise<void> {
		await browserFiles.writeFile({ resource: folderResource.joinPathSegment('paper.pdf.ash-annotations.json'), content: 'other window' }, { create: true, overwrite: true });
	},
	async pauseBrowserPdf(mode: 'missing' | 'failure'): Promise<void> {
		const folder = await browserProvider.getDirectoryHandle(folderResource);
		const reached = new DeferredPromise<void>();
		const release = new DeferredPromise<void>();
		let used = false;
		if (mode === 'missing') {
			const prototype = Object.getPrototypeOf(folder) as FileSystemDirectoryHandle;
			const original = prototype.getFileHandle;
			prototype.getFileHandle = async function (name, options) {
				try { return await original.call(this, name, options); }
				catch (error) {
					if (!used && name === 'paper.pdf.ash-annotations.json' && !options?.create && error instanceof DOMException && error.name === 'NotFoundError') {
						used = true;
						await reached.complete();
						await release.p;
					}
					throw error;
				}
			};
			resources.add(toDisposable(() => { prototype.getFileHandle = original; }));
		} else {
			const probe = await folder.getFileHandle('probe', { create: true });
			const prototype = Object.getPrototypeOf(probe) as FileSystemFileHandle;
			const original = prototype.createWritable;
			prototype.createWritable = async function (options) {
				const writable = await original.call(this, options);
				if (!used && this.name === 'paper.pdf.ash-annotations.json') {
					used = true;
					writable.write = async () => { await reached.complete(); await release.p; throw new Error('Injected write failure'); };
				}
				return writable;
			};
			resources.add(toDisposable(() => { prototype.createWritable = original; }));
		}
		resources.add(toDisposable(() => { void release.complete(); }));
		pdfPause = { reached: reached.p, release: () => release.complete() };
	},
	async waitBrowserPdfPause(): Promise<void> { await pdfPause!.reached; },
	async releaseBrowserPdf(): Promise<void> { await pdfPause!.release(); },
	readBrowserFile: async (name: string): Promise<string> => (await browserFiles.readFile(folderResource.joinPathSegment(name))).content,
};
window.ashBrowserPdfFiles = integration;
declare global { interface Window { ashBrowserPdfFiles: typeof integration; } }
