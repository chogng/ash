import { Event } from '../../../../../base/common/event.js';
import { createTestFileService } from '../../../../test/common/testEditorServices.js';
import { type IFileSystemProvider, type IFileWriteOptions, type IFileWriteResult, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { toDisposable, Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind, type IFileWriteRequest } from '../../../../../platform/files/common/files.js';
import { WorkspacePdfAnnotationStore, pdfAnnotationSidecarResource } from '../../../../../../../extensions/pdf-viewer/browser/pdfAnnotationStore.js';
import { emptyPdfAnnotationDocument, parsePdfAnnotationDocument } from '../../../../../../../extensions/pdf-viewer/common/pdfAnnotations.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { DiskFileSystemProvider } from '../../../../../platform/files/node/diskFileSystemProvider.js';
import { FileRevisionConflictError, FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PdfAnnotationDocument } from '../../../../../../../extensions/pdf-viewer/common/pdfAnnotations.js';

test('PDF annotation store returns an empty document when no sidecar exists', async () => {
	const resource = URI.file('/workspace/paper.pdf');
	const files = new TestFileService();
	using fileService = createTestFileService(files);
	const store = new WorkspacePdfAnnotationStore(fileService);

	const snapshot = await store.load(resource, new AbortController().signal);

	assert.deepEqual(snapshot.document, emptyPdfAnnotationDocument());
	assert.equal(snapshot.revision, undefined);
	assert.equal(files.readFileRequests.length, 0);
});

test('PDF annotation store reads and conditionally writes its sibling sidecar', async () => {
	const resource = URI.file('/workspace/paper.pdf');
	const sidecar = pdfAnnotationSidecarResource(resource);
	const files = new TestFileService();
	files.entries = [{ resource: sidecar, name: 'paper.pdf.ash-annotations.json', kind: FileKind.File }];
	files.content = '{\n  "version": 1,\n  "annotations": []\n}\n';
	files.revision = 'before';
	using fileService = createTestFileService(files);
	const store = new WorkspacePdfAnnotationStore(fileService);

	const loaded = await store.load(resource, new AbortController().signal);
	const saved = await store.save(resource, loaded.document, loaded.revision, new AbortController().signal);

	assert.equal(files.readFileRequests[0]?.toString(), sidecar.toString());
	assert.equal(files.writeRequests[0]?.resource.toString(), sidecar.toString());
	assert.equal(files.writeRequests[0]?.expectedRevision, 'before');
	assert.deepEqual(parsePdfAnnotationDocument(files.writeRequests[0]?.content ?? ''), emptyPdfAnnotationDocument());
	assert.equal(saved.revision, 'after');
});

class TestFileService implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	readonly onDidChangeFiles = () => toDisposable(() => { });
	entries: readonly { readonly resource: URI; readonly name: string; readonly kind: FileKind; }[] = [];
	content = '';
	revision = 'revision';
	readonly readFileRequests: URI[] = [];
	readonly writeRequests: IFileWriteRequest[] = [];

	async stat(resource: URI) {
		return { resource, kind: FileKind.File, sizeBytes: 0, readonly: false, modifiedAtMillis: undefined };
	}

	async readDirectory(): Promise<readonly { readonly resource: URI; readonly name: string; readonly kind: FileKind; }[]> {
		return this.entries;
	}

	async readFile(resource: URI) {
		this.readFileRequests.push(resource);
		return { resource, bytes: new TextEncoder().encode(this.content), revision: this.revision };
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (!options.overwrite) { throw new Error('PDF annotation tests do not paste files'); }
		const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
		this.writeRequests.push(request);
		return {
			stat: { resource: request.resource, kind: FileKind.File, sizeBytes: request.content.length, readonly: false, modifiedAtMillis: undefined },
			revision: 'after',
		};
	}

	async createFile(): Promise<never> { throw new Error('PDF annotation tests do not create empty files'); }
	async createDirectory(): Promise<never> { throw new Error('PDF annotation tests do not create directories'); }
	async copy(): Promise<void> { throw new Error('Copy is not used in this test'); }
	async rename(): Promise<never> { throw new Error('PDF annotation tests do not rename files'); }
	async delete(): Promise<never> { throw new Error('PDF annotation tests do not delete files'); }
}

test('provider retirement cancels a sidecar write through the authorized file service', async () => {
	const controller = new AbortController();
	let entered!: () => void;
	const writing = new Promise<void>(resolve => { entered = resolve; });
	const files = new TestFileService();
	files.writeFile = async (_resource, _bytes, _options, signal?: AbortSignal) => {
		assert.ok(signal);
		entered();
		return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('sidecar write cancelled')), { once: true }));
	};
	using service = createTestFileService(files);
	const store = new WorkspacePdfAnnotationStore(service);
	const saved = assert.rejects(store.save(URI.file('/workspace/paper.pdf'), emptyPdfAnnotationDocument(), undefined, controller.signal), /cancelled/);
	await writing;
	controller.abort();
	await saved;
});

for (const provider of ['memory', 'disk'] as const) {
	for (const order of ['first', 'second', 'concurrent'] as const) {
		test(`PDF first saves reject the stale window with ${provider} storage in ${order} order`, async () => {
			const fixture = await storePair(provider);
			try {
				const { stores, resource, files } = fixture;
				const signal = new AbortController().signal;
				const loaded = await Promise.all(stores.map(store => store.load(resource, signal)));
				assert.deepEqual(loaded, [0, 1].map(() => ({ document: emptyPdfAnnotationDocument(), revision: undefined })));
				const documents = [noteDocument('First window'), noteDocument('Second window')];
				const sequence = order === 'second' ? [1, 0] : [0, 1];
				const save = (index: number) => stores[index].save(resource, documents[index], loaded[index].revision, signal);
				const results = order === 'concurrent'
					? await Promise.allSettled(sequence.map(save))
					: [await save(sequence[0]).then(value => ({ status: 'fulfilled' as const, value })), ...(await Promise.allSettled([save(sequence[1])]))];
				assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
				const rejected = results.find(result => result.status === 'rejected');
				assert.ok(rejected?.status === 'rejected');
				assert.equal(toFileSystemProviderErrorCode(rejected.reason), FileSystemProviderErrorCode.FileExists);
				const winner = sequence[results.findIndex(result => result.status === 'fulfilled')];
				const persisted = await stores[0].load(resource, signal);
				assert.deepEqual(persisted.document, documents[winner]);
				assert.ok(persisted.revision);
				await assert.rejects(save(1 - winner), error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileExists);
				assert.deepEqual(await stores[1].load(resource, signal), persisted);
				const next = await stores[winner].save(resource, noteDocument('Winner updated'), persisted.revision, signal);
				await assert.rejects(stores[1 - winner].save(resource, documents[1 - winner], persisted.revision, signal), FileRevisionConflictError);
				assert.deepEqual(await stores[0].load(resource, signal), next);
				assert.equal((await files.readFile(resource)).content, '%PDF');
			} finally { await fixture.dispose(); }
		});
	}
}

test('PDF first save can retry a failed creation without weakening its absence condition', async () => {
	using memory = new InMemoryFileSystemProvider();
	const directory = URI.file('/workspace');
	await memory.createDirectory(directory);
	const write = memory.writeFile.bind(memory);
	let fail = true;
	memory.writeFile = async (...args) => {
		if (fail) { fail = false; throw new Error('disk full'); }
		return write(...args);
	};
	using files = createTestFileService(memory);
	const store = new WorkspacePdfAnnotationStore(files);
	const resource = URI.joinPath(directory, 'paper.pdf');
	const signal = new AbortController().signal;
	const document = noteDocument('Retry');
	await assert.rejects(store.save(resource, document, undefined, signal), /disk full/);
	assert.equal((await store.load(resource, signal)).revision, undefined);
	const saved = await store.save(resource, document, undefined, signal);
	assert.deepEqual(await store.load(resource, signal), saved);
});

test('PDF cancelled first save does not write, and a cancelled receipt cannot make a retry overwrite', async () => {
	using memory = new InMemoryFileSystemProvider();
	await memory.createDirectory(URI.file('/workspace'));
	using files = createTestFileService(memory);
	const store = new WorkspacePdfAnnotationStore(files);
	const resource = URI.file('/workspace/paper.pdf');
	const before = new AbortController();
	before.abort();
	await assert.rejects(store.save(resource, noteDocument('Cancelled'), undefined, before.signal), /cancelled/i);
	assert.equal((await store.load(resource, new AbortController().signal)).revision, undefined);
	const after = new AbortController();
	const write = memory.writeFile.bind(memory);
	memory.writeFile = async (...args) => { const result = await write(...args); after.abort(); return result; };
	const document = noteDocument('Published before cancellation');
	await assert.rejects(store.save(resource, document, undefined, after.signal), /cancelled/i);
	const signal = new AbortController().signal;
	await assert.rejects(store.save(resource, noteDocument('Retry'), undefined, signal), error => toFileSystemProviderErrorCode(error as Error) === FileSystemProviderErrorCode.FileExists);
	const loaded = await store.load(resource, signal);
	assert.deepEqual(loaded.document, document);
	assert.ok(loaded.revision);
	await store.save(resource, noteDocument('Explicitly refreshed'), loaded.revision, signal);
});

function noteDocument(text: string): PdfAnnotationDocument {
	return parsePdfAnnotationDocument(JSON.stringify({ version: 1, annotations: [{ id: 'test-note', kind: 'note', page: 1, point: { x: 0.5, y: 0.5 }, text, color: '#f6c945', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }] }));
}

async function storePair(provider: 'memory' | 'disk'): Promise<{ stores: WorkspacePdfAnnotationStore[]; files: ReturnType<typeof createTestFileService>; resource: URI; dispose(): Promise<void>; }> {
	const directory = provider === 'disk' ? await mkdtemp(join(await realpath(tmpdir()), 'ash-pdf-first-save-')) : undefined;
	const root = URI.file(directory ?? '/workspace');
	const first = provider === 'disk' ? new DiskFileSystemProvider([root]) : new InMemoryFileSystemProvider();
	const second = provider === 'disk' ? new DiskFileSystemProvider([root]) : first;
	await first.createDirectory(root);
	const files = createTestFileService(first);
	const otherFiles = createTestFileService(second);
	const resource = URI.joinPath(root, 'paper.pdf');
	await first.writeFile(resource, new Uint8Array([37, 80, 68, 70]), { create: true, overwrite: false });
	return {
		stores: [new WorkspacePdfAnnotationStore(files), new WorkspacePdfAnnotationStore(otherFiles)], files, resource, async dispose() {
			files.dispose(); otherFiles.dispose(); first.dispose(); if (second !== first) second.dispose();
			if (directory) await rm(directory, { recursive: true, force: true });
		}
	};
}
