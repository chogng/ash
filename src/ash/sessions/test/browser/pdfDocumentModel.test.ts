import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { Disposable, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { FileService } from '../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { IPdfDocument, IPdfService, PdfAnnotation, PdfAnnotationEdit, PdfPage } from '../../../platform/pdf/common/pdfService.js';
import { IUriIdentityService } from '../../../platform/uriIdentity/common/uriIdentity.js';
import { TestUriIdentityServices } from '../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { BrowserWorkingCopyService } from '../../../workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { WorkingCopyBackupTracker } from '../../../workbench/services/workingCopy/browser/workingCopyBackupTracker.js';
import { InMemoryWorkingCopyBackupService } from '../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { PdfDocumentModel } from '../../contrib/files/browser/pdfDocumentModel.js';

const resource = URI.file('/paper.pdf');
const signal = new AbortController().signal;
const note = { kind: 'note', bounds: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, contents: 'Saved note' } satisfies PdfAnnotationEdit;

for (const format of ['current', 'legacy'] as const) {
	test(`PDF ${format} recovery retains an unsaved undo until a normal save`, async () => {
		using store = new DisposableStore();
		const files = await createFiles(store);
		const dom = new JSDOM();
		store.add(toDisposable(() => dom.window.close()));
		const identity = store.add(new TestUriIdentityServices(files)).get(IUriIdentityService);
		const backups = store.add(new InMemoryWorkingCopyBackupService('pdf-test'));

		{
			using model = await openPdf(files);
			using copies = new BrowserWorkingCopyService(identity);
			using registration = copies.register(model);
			using tracker = new WorkingCopyBackupTracker(copies, backups, dom.window as unknown as Window);
			await model.render(1, note);
			await model.save(signal);
			assert.equal(model.isDirty, false);
			await model.undo();
			assert.equal(model.isDirty, true);
			await tracker.flush();
		}

		const backup = await backups.resolve(resource);
		assert.ok(backup);
		if (format === 'legacy') {
			const { source, edits, revision } = JSON.parse(backup.content);
			await backups.store({ ...backup, content: JSON.stringify({ source, edits, revision }) });
		}

		using recovered = await openPdf(files);
		using copies = new BrowserWorkingCopyService(identity);
		using registration = copies.register(recovered);
		using tracker = new WorkingCopyBackupTracker(copies, backups, dom.window as unknown as Window);
		assert.deepEqual(recovered.current?.annotations.map(annotation => annotation.contents), ['Saved note']);
		const recovery = await backups.resolve(resource);
		assert.ok(recovery);
		recovered.restoreBackup(recovery.content);
		const { page } = await recovered.render(1);
		assert.deepEqual(page.annotations, []);
		assert.equal(recovered.isDirty, true);
		await tracker.flush();
		assert.ok(await backups.resolve(resource));

		await recovered.save(signal);
		assert.equal(recovered.isDirty, false);
		await tracker.flush();
		assert.equal(await backups.resolve(resource), undefined);
		using reopened = await openPdf(files);
		assert.deepEqual(reopened.current?.annotations, []);
	});
}

test('PDF undo after recovery recognizes the saved annotation history', async () => {
	using store = new DisposableStore();
	const files = await createFiles(store);
	using model = await openPdf(files);
	await model.render(1, note);
	await model.save(signal);
	await model.render(1, { ...note, contents: 'Unsaved note' });

	using recovered = await openPdf(files);
	recovered.restoreBackup(model.backup());
	await recovered.render(1);
	assert.equal(recovered.isDirty, true);
	await recovered.undo();
	assert.deepEqual(recovered.current?.annotations.map(annotation => annotation.contents), ['Saved note']);
	assert.equal(recovered.isDirty, false);
});

test('PDF save retains the draft when recovery cannot reopen the original bytes', async () => {
	using store = new DisposableStore();
	const files = await createFiles(store);
	using model = await openPdf(files);
	await model.render(1, note);
	await model.save(signal);
	await model.undo();
	const annotated = await files.readFileBytes(resource);
	const error = new Error('Cannot reopen backup source');
	const failingPdf: IPdfService = {
		async open(bytes, signal): Promise<IPdfDocument> {
			if (new TextDecoder().decode(bytes) === '[]') throw error;
			return pdf.open(bytes, signal);
		},
	};

	using recovered = await openPdf(files, failingPdf);
	const backup = model.backup();
	recovered.restoreBackup(backup);
	await assert.rejects(recovered.save(signal), failure => failure === error);
	assert.equal(recovered.isDirty, true);
	assert.equal(recovered.backup(), backup);
	assert.deepEqual(await files.readFileBytes(resource), annotated);
});

for (const [editCount, saveAt] of [[1000, undefined], [1001, undefined], [1001, 500], [1001, 1000]] as const) {
	test(`PDF backs up ${editCount} edits to one note with save at ${saveAt ?? 'no edit'}`, async () => {
		using store = new DisposableStore();
		const files = await createFiles(store);
		using model = await openPdf(files);
		await editNote(model, editCount, saveAt);
		assert.equal(model.isDirty, true);
		const backup = model.backup();
		const data = JSON.parse(backup);
		assert.equal(data.edits.length, editCount === 1000 ? 1000 : 1);

		using recovered = await openPdf(files);
		assert.equal(recovered.current?.annotations[0]?.contents, saveAt === undefined ? undefined : `Edit ${saveAt}`);
		recovered.restoreBackup(backup);
		assert.equal((await recovered.render(1)).page.annotations[0]?.contents, `Edit ${editCount}`);
		assert.equal(recovered.isDirty, true);
		await recovered.undo();
		assert.equal(recovered.current?.annotations[0]?.contents, `Edit ${editCount - 1}`);
		assert.equal(recovered.isDirty, saveAt !== 1000);
		assert.equal(recovered.canUndo, editCount === 1000);
		await recovered.redo();
		await recovered.save(signal);
		assert.equal(recovered.isDirty, false);
		using reopened = await openPdf(files);
		assert.equal(reopened.current?.annotations[0]?.contents, `Edit ${editCount}`);
	});
}

test('PDF compacts an oversized legacy backup after recovering every edit', async () => {
	using store = new DisposableStore();
	const files = await createFiles(store);
	using model = await openPdf(files);
	await editNote(model, 1000, 500);
	const { version, source, edits, revision, savedEdits } = JSON.parse(model.backup());
	const legacy = { source, edits: [...edits, { page: 1, edit: noteUpdate(1001) }], revision, savedEdits };

	using recovered = await openPdf(files);
	assert.throws(() => recovered.restoreBackup(JSON.stringify({ ...legacy, version })), /Invalid aspdf recovery data/);
	recovered.restoreBackup(JSON.stringify(legacy));
	assert.equal((await recovered.render(1)).page.annotations[0]?.contents, 'Edit 1001');
	assert.equal(recovered.isDirty, true);
	const backup = recovered.backup();
	assert.equal(JSON.parse(backup).edits.length, 1000);
	using recoveredAgain = await openPdf(files);
	recoveredAgain.restoreBackup(backup);
	assert.equal((await recoveredAgain.render(1)).page.annotations[0]?.contents, 'Edit 1001');
	assert.equal(recoveredAgain.isDirty, true);
});

test('PDF preserves live undo across checkpoints and recovers a new branch as unsaved', async () => {
	using store = new DisposableStore();
	const files = await createFiles(store);
	using model = await openPdf(files);
	await editNote(model, 1001, 1001);
	await model.undo();
	assert.equal(model.current?.annotations[0]?.contents, 'Edit 1000');
	await model.undo();
	assert.equal(model.current?.annotations[0]?.contents, 'Edit 999');
	await model.redo();
	await model.redo();
	assert.equal(model.isDirty, false);
	await model.undo();
	await model.undo();
	await model.render(1, { kind: 'update', index: 0, contents: 'New branch' });
	await model.render(1, noteUpdate(1001));

	using recovered = await openPdf(files);
	recovered.restoreBackup(model.backup());
	assert.equal((await recovered.render(1)).page.annotations[0]?.contents, 'Edit 1001');
	assert.equal(recovered.isDirty, true);
	await recovered.undo();
	assert.equal(recovered.current?.annotations[0]?.contents, 'New branch');
	assert.equal(recovered.isDirty, true);
});

test('PDF preserves the last recoverable draft when checkpoint export fails and can retry the edit', async () => {
	using store = new DisposableStore();
	const files = await createFiles(store);
	const error = new Error('Checkpoint export failed');
	const pdfWithExportFailure: IPdfService = {
		async open(bytes, signal): Promise<IPdfDocument> {
			const document = await pdf.open(bytes, signal);
			const exportBytes = document.export.bind(document);
			let failNextExport = true;
			document.export = async (page, signal) => {
				if (failNextExport) {
					failNextExport = false;
					throw error;
				}
				return exportBytes(page, signal);
			};
			return document;
		},
	};
	using model = await openPdf(files, pdfWithExportFailure);
	await editNote(model, 1000);
	const backup = model.backup();
	await assert.rejects(model.render(1, noteUpdate(1001)), failure => failure === error);
	assert.equal((await model.render(1)).page.annotations[0]?.contents, 'Edit 1000');
	assert.equal(model.backup(), backup);

	await model.render(1, noteUpdate(1001));
	using recovered = await openPdf(files);
	recovered.restoreBackup(model.backup());
	assert.equal((await recovered.render(1)).page.annotations[0]?.contents, 'Edit 1001');
});

async function editNote(model: PdfDocumentModel, editCount: number, saveAt?: number): Promise<void> {
	await model.render(1, { ...note, contents: 'Edit 1' });
	for (let edit = 2; edit <= editCount; edit++) {
		await model.render(1, noteUpdate(edit));
		if (edit === saveAt) await model.save(signal);
	}
}

function noteUpdate(edit: number): PdfAnnotationEdit {
	return { kind: 'update', index: 0, contents: `Edit ${edit}` };
}

async function createFiles(store: DisposableStore): Promise<FileService> {
	const files = store.add(new FileService());
	const provider = store.add(new InMemoryFileSystemProvider());
	store.add(files.registerProvider(resource.scheme, provider));
	await files.writeFileBytes(resource, new TextEncoder().encode('[]'));
	return files;
}

async function openPdf(files: FileService, pdfService: IPdfService = pdf): Promise<PdfDocumentModel> {
	const model = new PdfDocumentModel({ resource }, files, pdfService);
	try {
		await model.open();
		await model.render(1);
		return model;
	} catch (error) {
		model.dispose();
		throw error;
	}
}

const pdf: IPdfService = {
	async open(bytes): Promise<IPdfDocument> {
		return new TestPdfDocument(JSON.parse(new TextDecoder().decode(bytes)));
	},
};

/** Represents the PDF service's page snapshots and exported bytes without a native worker. */
class TestPdfDocument extends Disposable implements IPdfDocument {
	constructor(private readonly annotations: PdfAnnotation[]) { super(); }

	async page(page: number, _dimension: number, _signal: AbortSignal, edit?: PdfAnnotationEdit): Promise<PdfPage> {
		if (edit?.kind === 'update') {
			const annotation = this.annotations[edit.index];
			assert.ok(annotation);
			this.annotations[edit.index] = { ...annotation, contents: edit.contents };
		} else if (edit) {
			assert.equal(edit.kind, 'note');
			this.annotations.push({ ...edit, author: '', index: this.annotations.length });
		}
		return {
			page, revision: 0, sha256: '', pageCount: 1, width: 1, height: 1, widthPoints: 1, heightPoints: 1,
			text: '', textTruncated: false, characters: [], annotations: this.annotations.slice(), annotationsTruncated: false,
			imageSize: 0, imageSha256: '', fileSize: 0,
		};
	}

	async image(): Promise<Uint8Array> { return new Uint8Array(); }

	async export(page: PdfPage): Promise<Uint8Array> {
		return new TextEncoder().encode(JSON.stringify(page.annotations));
	}
}
