import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { FileKind, IFileService, FileOperationNotSupportedError, FileSystemProviderErrorCode, createFileSystemProviderError } from '../../../../../platform/files/common/files.js';
import { createDisconnectedFileApi } from '../../../../../platform/files/browser/fileApi.js';
import { AppServerFileSystemProvider } from '../../../../../platform/agentHost/browser/appServerFileSystemProvider.js';
import { AppServerRemoteError } from '../../../../../platform/agentHost/common/appServerError.js';
import type { FsWriteBinaryFileParams, FsWriteFileElevatedParams, FsWriteFileResult } from '../../../../../../../.build/protocol/typescript/index.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { FilesConfigurationService, IFilesConfigurationService } from '../../../filesConfiguration/common/filesConfigurationService.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { IElevatedFileService } from '../../common/elevatedFileService.js';
import { ElectronElevatedFileService } from '../../electron-browser/elevatedFileService.js';
import { BrowserElevatedFileService } from '../../browser/elevatedFileService.js';
import { TextFileService } from '../../../textfile/browser/textFileService.js';
import { BrowserTextResourceStore } from '../../../../contrib/codeEditor/browser/browserTextResourceStore.js';
import { BrowserTextModelService } from '../../../textmodelResolver/browser/browserTextModelService.js';
import { TextModelConflictError } from '../../../textmodelResolver/common/textModelResourceService.js';

const resource = URI.file('/project/notes.txt');
const saved: FsWriteFileResult = { revision: 'saved-revision', metadata: { fileType: 'file', readonly: false, sizeBytes: 10, modifiedAtMillis: 1 } };

function fixture(write: (request: FsWriteFileElevatedParams, signal?: AbortSignal) => Promise<FsWriteFileResult>, ordinary?: (request: FsWriteBinaryFileParams) => Promise<FsWriteFileResult>) {
	const services = new InstantiationService();
	const workspace = new WorkspaceContextService({ id: 'project', uri: URI.file('/project') });
	const configuration = new InMemoryConfigurationService();
	const policy = new FilesConfigurationService(configuration, workspace);
	const provider = new AppServerFileSystemProvider({
		workspaceContextService: workspace,
		resourceApi: { connectionGeneration: 1, metadata: async () => { throw new Error('Unexpected resource metadata'); }, read: async () => { throw new Error('Unexpected resource read'); }, release: async () => undefined },
		api: { ...createDisconnectedFileApi(() => { throw new Error('Unexpected ordinary file operation'); }), writeFileElevated: write, ...(ordinary ? { writeBinaryFile: ordinary } : {}) },
	});
	provider.stat = async () => ({ resource, kind: FileKind.File, readonly: false, sizeBytes: 5, modifiedAtMillis: 1 });
	provider.readFile = async () => ({ resource, bytes: new TextEncoder().encode('\uFEFFold\r\n'), revision: 'original-revision' });
	const files = new FileService();
	const registration = files.registerProvider('file', provider);
	services.registerInstance(IFileService, files);
	services.registerInstance(IFilesConfigurationService, policy);
	services.registerSingleton(IElevatedFileService, () => services.createInstance(ElectronElevatedFileService));
	const textFiles = services.createInstance(TextFileService);
	const models = new BrowserTextModelService(new BrowserTextResourceStore(textFiles));
	return { services, textFiles, models, dispose(): void { models.dispose(); textFiles.dispose(); registration.dispose(); files.dispose(); provider.dispose(); policy.dispose(); configuration.dispose(); workspace.dispose(); services.dispose(); }, [Symbol.dispose](): void { this.dispose(); } };
}

test('explicit elevated model saves retain byte encoding, revision and completed-save events', async () => {
	const requests: FsWriteFileElevatedParams[] = [];
	using context = fixture(async request => { requests.push(request); return saved; });
	const completed: string[] = [];
	using listener = context.textFiles.onDidSave(event => completed.push(event.revision));
	using reference = await context.models.acquire({ resource }, new AbortController().signal);
	reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'editor\r\n' }]);
	assert.equal(reference.isDirty, true);
	await reference.save(new AbortController().signal, { writeElevated: true });
	assert.deepEqual({ dirty: reference.isDirty, completed, target: requests[0]?.path, dirId: requests[0]?.dirId, revision: requests[0]?.expectedRevision, bytes: Buffer.from(requests[0]!.dataBase64, 'base64').toString('utf8') }, {
		dirty: false, completed: ['saved-revision'], target: 'notes.txt', dirId: 'project', revision: 'original-revision', bytes: '\uFEFFeditor\r\n',
	});
});

test('cancelled authorization retains editor changes and emits no completed save', async () => {
	using context = fixture(async () => { throw new CancellationError(); });
	let completions = 0;
	using listener = context.textFiles.onDidSave(() => completions++);
	using reference = await context.models.acquire({ resource }, new AbortController().signal);
	reference.model.applyOperations([{ range: new Range(1, 1, 1, 1), text: 'edit' }]);
	await assert.rejects(reference.save(new AbortController().signal, { writeElevated: true }), CancellationError);
	assert.deepEqual({ dirty: reference.isDirty, completions, text: reference.model.getText() }, { dirty: true, completions: 0, text: 'editold\r\n' });
});

test('edits made during authorization remain dirty after the saved snapshot completes', async () => {
	const pending = new DeferredPromise<FsWriteFileResult>();
	const started = new DeferredPromise<void>();
	using context = fixture(async () => { started.complete(); return pending.p; });
	using reference = await context.models.acquire({ resource }, new AbortController().signal);
	reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'first' }]);
	const saving = reference.save(new AbortController().signal, { writeElevated: true });
	await started.p;
	reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'later' }]);
	pending.complete(saved);
	await saving;
	assert.deepEqual({ dirty: reference.isDirty, text: reference.model.getText() }, { dirty: true, text: 'later' });
});

test('elevated conflicts preserve the dirty model and mark its external change', async () => {
	using context = fixture(async () => { throw new AppServerRemoteError(-32042, 'different wording', { kind: 'FileSystemRevisionConflict' }); });
	using reference = await context.models.acquire({ resource }, new AbortController().signal);
	reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'editor' }]);
	await assert.rejects(reference.save(new AbortController().signal, { writeElevated: true }), TextModelConflictError);
	assert.deepEqual({ dirty: reference.isDirty, external: reference.hasExternalChange, text: reference.model.getText() }, { dirty: true, external: true, text: 'editor' });
});

test('cancellation after an acknowledged elevated write retains its completed revision', async () => {
	const controller = new AbortController();
	using context = fixture(async () => { controller.abort(); return saved; });
	using reference = await context.models.acquire({ resource }, new AbortController().signal);
	reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'editor' }]);
	await reference.save(controller.signal, { writeElevated: true });
	assert.equal(reference.isDirty, false);
});

test('browser elevation is unsupported and system write permission errors have a stable category', async () => {
	const service = new BrowserElevatedFileService();
	assert.equal(service.isSupported(resource), false);
	const error = createFileSystemProviderError('different language', FileSystemProviderErrorCode.NoPermissions);
	assert.equal(error.code, FileSystemProviderErrorCode.NoPermissions);
	using context = fixture(async () => { throw new AppServerRemoteError(-32044, 'different wording', { kind: 'FileSystemPermissionDenied' }); });
	await assert.rejects(context.textFiles.save({ resource, text: 'edit', writeElevated: true }, new AbortController().signal), error => error instanceof Error && 'code' in error && error.code === FileSystemProviderErrorCode.NoPermissions);
});

test('unsupported elevated provider modes fail before requesting authorization', async () => {
	using context = fixture(async () => { throw new Error('Must not request system authorization'); });
	for (const options of [{ create: true, overwrite: false }, { create: false, overwrite: true }]) {
		await assert.rejects(context.services.get(IFileService).writeFileBytes(resource, new Uint8Array(), { ...options, writeElevated: true, expectedRevision: 'original-revision' }), FileOperationNotSupportedError);
	}
});


test('explicit ordinary overwrite keeps encoding and revision without requesting elevation', async () => {
	const requests: FsWriteBinaryFileParams[] = [];
	using context = fixture(async () => { throw new Error('Must not elevate an ordinary overwrite'); }, async request => { requests.push(request); return saved; });
	using reference = await context.models.acquire({ resource }, new AbortController().signal);
	reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'overwrite\r\n' }]);
	await reference.save(new AbortController().signal, { unlock: true, skipSaveParticipants: true });
	assert.deepEqual({ dirty: reference.isDirty, options: requests[0]?.options, bytes: Buffer.from(requests[0]!.dataBase64, 'base64').toString('utf8') }, {
		dirty: false, options: { mode: 'replace', unlock: true, expectedRevision: 'original-revision' }, bytes: '\uFEFFoverwrite\r\n',
	});
});

test('authorization failures expose distinct localized causes and keep the model dirty', async () => {
	for (const [kind, code, message] of [
		['FileSystemElevationDenied', FileSystemProviderErrorCode.NoPermissions, 'System authorization was declined. Your changes remain unsaved.'],
		['FileSystemElevationUnavailable', FileSystemProviderErrorCode.Unavailable, 'System authorization is unavailable on this host.'],
		['FileSystemElevationTimedOut', FileSystemProviderErrorCode.Unavailable, 'System authorization timed out. Your changes remain unsaved.'],
		['FileSystemElevationFailed', FileSystemProviderErrorCode.Unavailable, 'System authorization or the save helper failed. Check the App Server log. Your changes remain unsaved.'],
	] as const) {
		using context = fixture(async () => { throw new AppServerRemoteError(-32049, 'different wording', { kind }); });
		using reference = await context.models.acquire({ resource }, new AbortController().signal);
		reference.model.applyOperations([{ range: new Range(1, 1, 1, 1), text: 'edit' }]);
		await assert.rejects(reference.save(new AbortController().signal, { writeElevated: true }), error => error instanceof Error && 'code' in error && error.code === code && error.message === message);
		assert.equal(reference.isDirty, true);
	}
});
