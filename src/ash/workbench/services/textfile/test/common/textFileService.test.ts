import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { Disposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { type IFileSystemProvider, type IFileWriteOptions, type IFileWriteResult, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { createTestFileService, createTestTextFileService } from '../../../../test/common/testEditorServices.js';
import { BulkEditTestServices } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { BulkEditService } from '../../../../contrib/bulkEdit/browser/bulkEditService.js';
import assert from 'node:assert/strict';
import { test, suiteTeardown } from 'mocha';
import { isCancellationError } from '../../../../../base/common/errors.js';
import { BrowserTextModelService } from '../../../textmodelResolver/browser/browserTextModelService.js';
import { BrowserTextResourceStore } from '../../../../contrib/codeEditor/browser/browserTextResourceStore.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { URI } from '../../../../../base/common/uri.js';
import { FileKind, FileRevisionConflictError, type IFileWriteRequest } from '../../../../../platform/files/common/files.js';
import {
	TextFileBinaryError,
	TextFileContentSource,
	TextFileSaveConflictError,
	TextFileTooLargeError,
} from '../../../../../workbench/services/textfile/common/textFileService.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

test('TextFileService uses bootstrap content without reading the workspace', async () => {
	const files = new TestFileService('workspace');
	using service = createTestTextFileService(files);
	const resource = URI.file('C:\\project\\main.ts');

	const content = await service.resolve({ resource, bootstrapText: 'bootstrap' }, new AbortController().signal);

	assert.equal(content.text, 'bootstrap');
	assert.equal(content.source, TextFileContentSource.Bootstrap);
	assert.equal(content.revision, undefined);
	assert.equal(content.encoding, 'utf8');
	assert.equal(files.readCount, 0);
});

test('TextFileService reads missing bootstrap content and observes cancellation', async () => {
	const files = new TestFileService('workspace');
	using service = createTestTextFileService(files);
	const resource = URI.file('C:\\project\\main.ts');
	const content = await service.resolve({ resource }, new AbortController().signal);
	assert.equal(content.text, 'workspace');
	assert.equal(content.source, TextFileContentSource.FileSystem);
	assert.equal(content.revision, 'revision-1');
	assert.equal(content.encoding, 'utf8');

	const cancelled = new AbortController();
	cancelled.abort('closed');
	await assert.rejects(service.resolve({ resource }, cancelled.signal), isCancellationError);
	assert.equal(files.readCount, 1);
});

test('TextFileService cancels before starting a byte read when metadata resolution yields', async () => {
	const pending = deferred<string>();
	const files = new TestFileService(pending.promise);
	using service = createTestTextFileService(files);
	const controller = new AbortController();
	const resolving = service.resolve({ resource: URI.file('C:\\project\\slow.ts') }, controller.signal);

	controller.abort('closed');
	await assert.rejects(resolving, isCancellationError);
	pending.resolve('late');
	assert.equal(files.readCount, 0);
});

test('TextFileService preserves file-system failures', async () => {
	const failure = new Error('unreadable');
	using service = createTestTextFileService(new TestFileService(Promise.reject(failure)));

	await assert.rejects(
		service.resolve({ resource: URI.file('C:\\project\\main.ts') }, new AbortController().signal),
		error => error === failure,
	);
});

test('TextFileService decodes a UTF-8 BOM and rejects binary or invalid UTF-8 content', async () => {
	const resource = URI.file('C:\\project\\content.txt');
	const withBom = new TestFileService(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]));
	assert.equal((await createTestTextFileService(withBom).resolve({ resource }, new AbortController().signal)).text, 'hi');

	await assert.rejects(
		createTestTextFileService(new TestFileService(new Uint8Array([0x68, 0x00, 0x69]))).resolve({ resource }, new AbortController().signal),
		TextFileBinaryError,
	);
	await assert.rejects(
		createTestTextFileService(new TestFileService(new Uint8Array([0xc3, 0x28]))).resolve({ resource }, new AbortController().signal),
		TextFileBinaryError,
	);
});

test('TextFileService rejects oversized resources before reading their bytes', async () => {
	const files = new TestFileService('small');
	files.reportedSizeBytes = 32 * 1024 * 1024 + 1;

	await assert.rejects(
		createTestTextFileService(files).resolve({ resource: URI.file('C:\\project\\large.txt') }, new AbortController().signal),
		TextFileTooLargeError,
	);
	assert.equal(files.readCount, 0);
});

test('TextFileService writes text and observes cancellation', async () => {
	const files = new TestFileService('workspace');
	using service = createTestTextFileService(files);
	const resource = URI.file('C:\\project\\main.ts');

	const saved = await service.save({ resource, text: 'saved', expectedRevision: 'revision-1' }, new AbortController().signal);
	assert.deepEqual(files.writes, [{ resource, content: 'saved', expectedRevision: 'revision-1' }]);
	assert.equal(saved.revision, 'revision-2');

	const cancelled = new AbortController();
	cancelled.abort('closed');
	await assert.rejects(service.save({ resource, text: 'ignored' }, cancelled.signal), isCancellationError);
	assert.equal(files.writes.length, 1);
});

test('TextFileService maps conditional file-write conflicts to its editor-facing error', async () => {
	const files = new TestFileService('workspace');
	files.rejectWritesWithRevisionConflict = true;
	using service = createTestTextFileService(files);
	const resource = URI.file('C:\\project\\main.ts');

	await assert.rejects(service.save({ resource, text: 'saved', expectedRevision: 'stale' }, new AbortController().signal), TextFileSaveConflictError);
});

test('cancelled replacement waits for an in-flight provider write before restoring the original file', async () => {
	const resource = URI.file('/workspace/main.ts');
	const started = deferred<void>();
	const release = deferred<void>();
	let disk = 'workspace';
	let revision = 'revision-1';
	const writes: string[] = [];
	const provider = new TestFileService(disk);
	provider.writeFile = async (resource, bytes, options) => {
		if (options.expectedRevision !== revision) throw new FileRevisionConflictError(resource);
		if (writes.length === 0) {
			started.resolve();
			// This provider cannot interrupt a write already submitted to storage.
			await release.promise;
		}
		disk = new TextDecoder().decode(bytes);
		writes.push(disk);
		revision = `revision-${writes.length + 1}`;
		return { stat: await provider.stat(resource), revision };
	};
	using files = createTestFileService(provider);
	using service = createTestTextFileService(files);
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(service), {});
	using fixture = new BulkEditTestServices([]);
	using bulk = new BulkEditService(models, fixture.workingCopies, files, fixture.configuration, fixture.dialogs);
	const controller = new AbortController();
	const replacing = bulk.apply({ entries: [{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 1, 1, 10), text: 'replacement' }] }] }, { token: controller.signal });
	const rejected = assert.rejects(replacing, isCancellationError);
	let settled = false;
	void replacing.then(() => { settled = true; }, () => { settled = true; });
	await started.promise;
	controller.abort();
	try {
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.deepEqual({ settled, disk, writes }, { settled: false, disk: 'workspace', writes: [] });
	} finally {
		release.resolve();
	}
	await rejected;
	assert.deepEqual({ disk, writes, pending: models.hasPendingSaveRecovery() }, { disk: 'workspace', writes: ['replacement', 'workspace'], pending: false });
});

class TestFileService implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	readCount = 0;
	reportedSizeBytes: number | undefined;
	readonly writes: IFileWriteRequest[] = [];
	rejectWritesWithRevisionConflict = false;
	readonly onDidChangeFiles = () => ({
		dispose() { },
		[Symbol.dispose]() { },
	});

	constructor(private readonly content: string | Uint8Array | Promise<string>) { }

	async stat(resource: URI) {
		return {
			resource,
			kind: FileKind.File,
			sizeBytes: this.reportedSizeBytes ?? (typeof this.content === 'string' || this.content instanceof Uint8Array ? this.content.length : 0),
			readonly: false,
			modifiedAtMillis: undefined,
		};
	}

	async readDirectory() {
		return [];
	}

	async readFile(resource: URI) {
		this.readCount += 1;
		const content = await this.content;
		return { resource, bytes: typeof content === 'string' ? new TextEncoder().encode(content) : content, revision: 'revision-1' };
	}

	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (!options.overwrite) { throw new Error('Text file tests do not paste files'); }
		const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
		if (this.rejectWritesWithRevisionConflict) throw new FileRevisionConflictError(request.resource);
		this.writes.push(request);
		return {
			stat: {
				resource: request.resource,
				kind: FileKind.File,
				sizeBytes: request.content.length,
				readonly: false,
				modifiedAtMillis: undefined,
			},
			revision: 'revision-2',
		};
	}

	async createFile(): Promise<never> { throw new Error('Text file tests do not create empty files'); }
	async createDirectory(): Promise<never> { throw new Error('Text file tests do not create directories'); }
	async copy(): Promise<void> { throw new Error('Copy is not used in this test'); }
	async rename(): Promise<never> { throw new Error('Text file tests do not rename files'); }
	async delete(): Promise<never> { throw new Error('Text file tests do not delete files'); }
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void; } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(resolver => {
		resolve = resolver;
	});
	return { promise, resolve };
}

test('text-file editing preserves UTF-8 BOM through the model, resource adapter and save service', async () => {
	for (const hasBom of [false, true]) {
		const files = new TestFileService(new TextEncoder().encode((hasBom ? '\uFEFF' : '') + 'first\r\nsecond'));
		using service = createTestTextFileService(files);
		using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(service), {});
		using reference = await models.acquire({ resource: URI.file('C:\\project\\bom.txt') }, new AbortController().signal);
		reference.model.applyOperations([{ range: new Range(1, 1, 1, 6), text: 'saved' }]);
		await reference.save(new AbortController().signal);
		assert.deepEqual({ text: reference.model.getText(), dirty: reference.isDirty, written: files.writes[0]?.content }, {
			text: 'saved\r\nsecond', dirty: false, written: (hasBom ? '\uFEFF' : '') + 'saved\r\nsecond',
		});
	}
});

test('text-file decoding retains a leading content character after the UTF-8 BOM', async () => {
	const resource = URI.file('C:\\project\\bom.txt');
	using service = createTestTextFileService(new TestFileService(new TextEncoder().encode('\uFEFF\uFEFFcontent')));
	using models = uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(service), {});
	using reference = await models.acquire({ resource }, new AbortController().signal);
	assert.equal(reference.model.getText(), '\uFEFFcontent');
});

test('TextFileService forwards configured detection and language overrides, with explicit reopen precedence', async () => {
	const { TestConfigurationService: WorkbenchConfigurationService } = await import('../../../configuration/test/common/testServices.js');
	await import('../../../../contrib/files/browser/files.contribution.js');
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue('files.encoding', 'windows1252');
	await configuration.updateValue('files.autoGuessEncoding', true);
	await configuration.updateValue('files.candidateGuessEncodings', ['utf8', 'cp950']);
	await configuration.updateValue('files.encoding', 'cp1125', { overrideIdentifiers: ['typescript'] });
	const requests: unknown[] = [];
	const files = Object.assign(new TestFileService('unused'), {
		readTextFile: async (resource: URI, encoding: string, options: unknown) => {
			requests.push({ encoding, options });
			return { resource, content: 'decoded', encoding: 'cp950', revision: 'bytes-revision' };
		},
	});
	using service = createTestTextFileService(files, configuration);
	const resource = URI.file('/project/file.ts');
	assert.equal((await service.resolve({ resource, languageId: 'typescript' }, new AbortController().signal)).encoding, 'cp950');
	await service.resolve({ resource, encoding: 'cp850', autoGuessEncoding: true }, new AbortController().signal);
	assert.deepEqual(requests, [
		{ encoding: 'cp1125', options: { autoGuessEncoding: true, candidateGuessEncodings: ['utf8', 'cp950'] } },
		{ encoding: 'cp850', options: undefined },
	]);
	assert.equal((await service.resolve({ resource, languageId: 'typescript', bootstrapText: 'untitled' }, new AbortController().signal)).encoding, 'cp1125');
	await assert.rejects(configuration.updateValue('files.candidateGuessEncodings', ['unsupported']), /unique detectable/);
	await assert.rejects(configuration.updateValue('files.autoGuessEncoding', 'yes'), /true or false/);
	await assert.rejects(configuration.updateValue('files.encoding', 'unsupported'), /Unsupported/);
	assert.deepEqual(configuration.getValue('files.candidateGuessEncodings'), ['utf8', 'cp950']);
});
