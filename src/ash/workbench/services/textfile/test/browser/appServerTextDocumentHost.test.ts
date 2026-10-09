import { TestUriIdentityServices } from '../../../../../platform/uriIdentity/test/common/uriIdentityTestServices.js';
import { type IFileSystemProvider, type IFileWriteOptions, type IFileWriteResult, FileSystemProviderCapabilities } from '../../../../../platform/files/common/files.js';
import { createTestFileService, createTestTextFileService } from '../../../../test/common/testEditorServices.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { TestDialogService } from '../../../../contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { BulkEditService } from '../../../../contrib/bulkEdit/browser/bulkEditService.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { IAccessibilitySignalService } from '../../../../../platform/accessibilitySignal/browser/accessibilitySignalService.js';
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { test, suiteTeardown } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { Schemas } from '../../../../../base/common/network.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { AppServerProtocolClient } from '../../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../../../platform/agentHost/common/appServerTransport.js';
import { APP_SERVER_SCHEMA_HASH, APP_SERVER_PROTOCOL_MAJOR, type InitializeResult, type ServerCapabilities, type AppServerServerRequestMethod, type ServerRequestParams, type ServerRequestResult } from '../../../../../../../.build/protocol/typescript/index.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, type IFileService, type IFileWriteRequest, type FileExistingTargetBehavior } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { BrowserTextResourceStore } from '../../../../contrib/codeEditor/browser/browserTextResourceStore.js';
import { BrowserTextModelService } from '../../../textmodelResolver/browser/browserTextModelService.js';
import { ITextModelResourceService } from '../../../textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../../textmodelResolver/common/textModelResolverService.js';
import { BrowserWorkingCopyService } from '../../../workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../workingCopy/common/workingCopyService.js';
import { AppServerTextDocumentHost } from '../../browser/appServerTextDocumentHost.js';
import { ChatEditingService } from '../../../../contrib/chat/browser/chatEditing/chatEditingServiceImpl.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const uriIdentityServices = new TestUriIdentityServices();
suiteTeardown(() => uriIdentityServices.dispose());

ensureNoDisposablesAreLeakedInTestSuite();

class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	private readonly replies = new Map<string, (result: unknown) => void>();
	private sequence = 0;
	public on(event: string, listener: (value: unknown) => void): void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
	}
	public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	private emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(value); } }
	public finishTurn(threadId: string, turnId: string, outcome: 'completed' | 'failed' | 'interrupted' = 'completed'): void {
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', method: 'textDocument/turnFinished', params: { threadId, turnId, outcome } }) });
	}
	public call<M extends AppServerServerRequestMethod>(method: M, params: ServerRequestParams<M>): Promise<ServerRequestResult<M>> {
		const id = `client-host:7:${++this.sequence}`;
		const reply = new Promise<ServerRequestResult<M>>(resolve => this.replies.set(id, result => resolve(result as ServerRequestResult<M>)));
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
		return reply;
	}
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/workspace' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as { id: number | string; method?: string; result?: unknown; error?: unknown; };
		if (request.method === 'initialize') {
			let result: InitializeResult;
			const capabilities = {
				agentInteractions: true,
				documentCollaboration: true,
				sessions: true,
				threads: true,
				turns: true,
				projects: true,
				memories: true, approvalEnvironment: true,
				resources: true,
				attachments: true,
				fileSystem: true,
				git: true,
				github: false,
				contentSearch: true,
				codebase: true,
				cloudCodebase: true,
				terminal: true,
				debugAdapter: true,
				typst: true,
				updateReplay: true,
				extensions: true,
				extensionHost: true,
				connectors: true,
				plugins: true,
				marketplace: true,
				mcp: true,
				mcpOAuth: true,
			} satisfies Omit<ServerCapabilities, 'contracts'>;
			result = { serverInfo: { name: 'ash-app-server', version: '1' }, protocolVersion: { major: APP_SERVER_PROTOCOL_MAJOR }, schemaHash: APP_SERVER_SCHEMA_HASH, capabilities: { ...capabilities, contracts: { memoryDiagnostics: { version: 1 } } }, slashCommands: [] } satisfies InitializeResult;

			this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
		} else if (typeof request.id === 'string') {
			this.replies.get(request.id)?.(request.result ?? request.error);
			this.replies.delete(request.id);
		}
	}
}

class Files extends Disposable implements IFileSystemProvider {
	public readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.FileFolderCopy;
	public readonly onDidChangeCapabilities = Event.None;
	public watch(): IDisposable { return Disposable.None; }

	private readonly changes = this._register(new Emitter<{ resources: readonly URI[]; }>());
	public readonly onDidChangeFiles = this.changes.event;
	public readonly contents = new Map<string, string>();
	public failRename = false;
	public constructor() { super(); }
	public async stat(resource: URI) {
		const content = this.contents.get(resource.toString());
		if (content === undefined) { throw new FileNotFoundError(resource); }
		return { resource, kind: FileKind.File, sizeBytes: new TextEncoder().encode(content).length, readonly: false, modifiedAtMillis: undefined };
	}
	public async readDirectory(): Promise<readonly never[]> { return []; }
	public async readFile(resource: URI) {
		const content = this.contents.get(resource.toString());
		if (content === undefined) throw new FileNotFoundError(resource);
		return { resource, bytes: new TextEncoder().encode(content), revision: content };
	}
	public async writeFile(resource: URI, bytes: Uint8Array, options: IFileWriteOptions): Promise<IFileWriteResult> {
		if (!options.overwrite) { return this.writeFile(resource, new TextEncoder().encode(new TextDecoder('utf8', { ignoreBOM: true }).decode(bytes)), { create: true, overwrite: true }); }
		const request = { resource, content: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes), ...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }) };
		if (request.expectedRevision !== undefined && request.expectedRevision !== this.contents.get(request.resource.toString())) { throw new FileRevisionConflictError(request.resource); }
		this.contents.set(request.resource.toString(), request.content);
		return { stat: await this.stat(request.resource), revision: request.content };
	}
	public async createFile(resource: URI, existing: FileExistingTargetBehavior) {
		if (this.contents.has(resource.toString())) {
			if (existing === 'error') { throw new Error('File already exists'); }
			if (existing === 'ignore') { return this.stat(resource); }
		}
		this.contents.set(resource.toString(), '');
		return this.stat(resource);
	}
	public async createDirectory(): Promise<never> { throw new Error('Not used'); }
	public async copy(): Promise<void> { throw new Error('Not used'); }
	public async rename(source: URI, target: URI): Promise<void> {
		if (this.failRename) { throw new Error('Injected rename failure'); }
		const content = await this.readFile(source);
		this.contents.delete(source.toString());
		this.contents.set(target.toString(), new TextDecoder('utf8', { ignoreBOM: true }).decode(content.bytes));
	}
	public async delete(resource: URI): Promise<void> { this.contents.delete(resource.toString()); }
}

async function fixture() {
	const lifetime = new DisposableStore();
	const files = lifetime.add(new Files());
	const models = lifetime.add(uriIdentityServices.createInstance(BrowserTextModelService, new BrowserTextResourceStore(lifetime.add(createTestTextFileService(files))), {}));
	const workingCopies = lifetime.add(uriIdentityServices.createInstance(BrowserWorkingCopyService));
	const configuration = lifetime.add(new InMemoryConfigurationService());
	const dialogs = new TestDialogService();
	const bulk = lifetime.add(new BulkEditService(models, workingCopies, lifetime.add(createTestFileService(files)), configuration, dialogs));
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(ITextModelResourceService, models);
	services.registerInstance(IBulkEditService, bulk);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
	const cues: string[] = [];
	services.registerInstance(IAccessibilitySignalService, { playSignal: async signal => { cues.push(signal.settingsKey); }, playSignalLoop: () => Disposable.None });
	const editing = lifetime.add(services.createInstance(ChatEditingService));
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	lifetime.add(toDisposable(() => client.dispose()));
	lifetime.add(services.createInstance(AppServerTextDocumentHost, client, { applyEdits: editing.applyEdits.bind(editing), finishTurn: editing.finishTurn.bind(editing) }));
	await client.connect();
	return { files, models, workingCopies, services, transport, client, editing, bulk, configuration, cues, ...toDisposable(() => lifetime.dispose()) };
}

async function snapshot(transport: Transport, resource: URI): Promise<string> {
	const result = await transport.call('textDocument/read', { path: resource.fsPath });
	assert.equal(result.kind, 'document', JSON.stringify(result));
	if (result.kind !== 'document') { throw new Error('Document was not resolved'); }
	return result.snapshot;
}

function workingCopy(reference: Awaited<ReturnType<BrowserTextModelService['acquire']>>): IWorkingCopy {
	return { resource: reference.resource, backupKind: 'text', get isDirty() { return reference.isDirty; }, get hasExternalChange() { return reference.hasExternalChange; }, onDidChangeDirty: reference.onDidChangeDirty, onDidChangeExternalChange: reference.onDidChangeExternalChange, onDidChangeContent: listener => reference.model.onDidChangeContent(() => listener()), backup: () => reference.model.getText(), restoreBackup: content => reference.model.reset(content), save: signal => reference.save(signal), saveAs: async () => { }, revert: signal => reference.revert(signal), ...toDisposable(() => { }) };
}

test('Agent review rejects one hunk, accepts another, saves the baseline and retains user edits', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/review.txt');
	host.files.contents.set(resource.toString(), '\uFEFFfirst\r\nseparator\r\nlast');
	using reference = await host.models.acquire({ resource }, new AbortController().signal);
	using copy = workingCopy(reference);
	using registration = host.workingCopies.register(copy);
	const id = await snapshot(host.transport, resource);
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: 'agent first\nseparator\nagent last' }] }), { kind: 'applied' });
	const entry = host.editing.entries[0]!;
	assert.equal(entry.hunks.length, 2);
	await entry.accept(entry.hunks[0]);
	reference.model.applyOperations([{ range: new Range(2, 1, 2, 1), text: 'user ' }]);
	await entry.reject();
	assert.deepEqual({ text: reference.model.getText(), file: host.files.contents.get(resource.toString()), pending: host.editing.entries.length }, { text: 'agent first\r\nuser separator\r\nlast', file: '\uFEFFagent first\r\nuser separator\r\nlast', pending: 0 });
	assert.ok(reference.model.undo());
	assert.equal(reference.model.getText(), 'agent first\r\nuser separator\r\nagent last');
});

test('Agent review keeps a user replacement inside a pending change', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/user-replacement.txt');
	host.files.contents.set(resource.toString(), 'first\nseparator\nlast');
	using reference = await host.models.acquire({ resource }, new AbortController().signal);
	const id = await snapshot(host.transport, resource);
	await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: 'agent first\nseparator\nagent last' }] });
	reference.model.applyOperations([{ range: new Range(1, 1, 1, 12), text: 'user first' }]);
	await host.editing.reject();
	assert.equal(reference.model.getText(), 'user first\nseparator\nlast');
});

test('consecutive Agent edits keep one review baseline and accepting releases it', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/consecutive.txt');
	host.files.contents.set(resource.toString(), 'original');
	for (const text of ['first agent', 'second agent']) {
		const id = await snapshot(host.transport, resource);
		assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text }] }), { kind: 'applied' });
	}
	assert.equal(host.editing.entries.length, 1);
	assert.equal(host.editing.entries[0]!.hunks[0]!.originalText, 'original');
	await host.editing.accept();
	assert.equal(host.editing.entries.length, 0);
	assert.equal(host.models.getModel(resource), null);
	assert.equal(host.files.contents.get(resource.toString()), 'second agent');
});

for (const [before, after] of [['first\nlast', 'first'], ['first', 'first\nlast'], ['', 'new'], ['old', ''], ['first\n', 'first'], ['first', 'first\n']] as const) {
	test(`Agent review rejects EOF changes ${JSON.stringify(before)} -> ${JSON.stringify(after)}`, async () => {
		using host = await fixture();
		const resource = URI.file('c:/workspace/eof.txt');
		host.files.contents.set(resource.toString(), before);
		const id = await snapshot(host.transport, resource);
		assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: after }] }), { kind: 'applied' });
		await host.editing.reject();
		assert.equal(host.files.contents.get(resource.toString()), before);
	});
}

test('Agent review rejects an atomic create, move and delete batch', async () => {
	using host = await fixture();
	const deleted = URI.file('c:/workspace/deleted.txt');
	const moved = URI.file('c:/workspace/moved.txt');
	const target = URI.file('c:/workspace/target.txt');
	const created = URI.file('c:/workspace/created.txt');
	host.files.contents.set(deleted.toString(), '\uFEFFdeleted\r\n');
	host.files.contents.set(moved.toString(), 'moved');
	const a = await snapshot(host.transport, deleted);
	const b = await snapshot(host.transport, moved);
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'delete', snapshot: a }, { kind: 'move', snapshot: b, target: target.fsPath, text: 'agent moved' }, { kind: 'create', path: created.fsPath, text: 'created' }] }), { kind: 'applied' });
	assert.equal(host.editing.entries.length, 1);
	await host.editing.reject();
	assert.deepEqual([...host.files.contents].sort(), [[deleted.toString(), '\uFEFFdeleted\r\n'], [moved.toString(), 'moved']].sort());
});

test('Agent review combines creating and subsequently editing the same file', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/new-review.txt');
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'create', path: resource.fsPath, text: 'created' }] }), { kind: 'applied' });
	const id = await snapshot(host.transport, resource);
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: 'updated' }] }), { kind: 'applied' });
	assert.equal(host.editing.entries.length, 1);
	await host.editing.reject();
	assert.equal(host.files.contents.has(resource.toString()), false);
});

test('Agent review combines modifying and subsequently moving the same file', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/before-move.txt');
	const target = URI.file('c:/workspace/after-move.txt');
	host.files.contents.set(resource.toString(), 'original');
	const first = await snapshot(host.transport, resource);
	await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: first, text: 'updated' }] });
	const second = await snapshot(host.transport, resource);
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'move', snapshot: second, target: target.fsPath, text: 'moved' }] }), { kind: 'applied' });
	await host.editing.reject();
	assert.deepEqual([...host.files.contents], [[resource.toString(), 'original']]);
});

test('review decisions wait for an in-flight Agent write', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/queued-review.txt');
	host.files.contents.set(resource.toString(), 'original');
	const id = await snapshot(host.transport, resource);
	await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: 'first' }] });
	const entry = host.editing.entries[0]!;
	const gate = new DeferredPromise<void>();
	const started = new DeferredPromise<void>();
	const apply = host.bulk.apply.bind(host.bulk);
	host.bulk.apply = async (edit, options) => { void started.complete(); await gate.p; return apply(edit, options); };
	const write = host.editing.applyEdits({ entries: [{ kind: 'textDocument', resource, edits: [{ range: new Range(1, 1, 1, 6), text: 'second' }] }] }, new AbortController().signal, { threadId: 'review-thread', turnId: 'review-turn' });
	await started.p;
	const reject = host.editing.rejectEntry(entry);
	assert.equal(entry.isBusy, true);
	void gate.complete();
	await Promise.all([write, reject]);
	assert.equal(host.files.contents.get(resource.toString()), 'original');
	assert.equal(host.editing.entries.length, 0);
});

test('a failed rejection save keeps the review available for retry', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/retry-review.txt');
	host.files.contents.set(resource.toString(), 'original');
	const id = await snapshot(host.transport, resource);
	await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: 'agent' }] });
	const entry = host.editing.entries[0]!;
	const save = host.files.writeFile.bind(host.files);
	host.files.writeFile = async () => { throw new Error('Injected review save failure'); };
	await assert.rejects(host.editing.rejectEntry(entry), /Injected review save failure/);
	assert.deepEqual(host.cues, ['accessibility.signals.chatEditModifiedFile']);
	assert.equal(host.editing.entries[0], entry);
	assert.equal(entry.isBusy, false);
	host.files.writeFile = save;
	await host.editing.rejectEntry(entry);
	assert.deepEqual(host.cues, ['accessibility.signals.chatEditModifiedFile', 'accessibility.signals.editsUndone']);
	assert.equal(host.files.contents.get(resource.toString()), 'original');
	assert.equal(host.editing.entries.length, 0);
});

test('document search snapshots contain only unsaved text within the requested directory', async () => {
	using host = await fixture();
	const inside = URI.file('c:/workspace/open.txt');
	const outside = URI.file('c:/workspace-other/open.txt');
	host.files.contents.set(inside.toString(), 'disk');
	host.files.contents.set(outside.toString(), 'outside');
	using a = await host.models.acquire({ resource: inside }, new AbortController().signal);
	using b = await host.models.acquire({ resource: outside }, new AbortController().signal);
	using copyA = workingCopy(a);
	using copyB = workingCopy(b);
	using registeredA = host.workingCopies.register(copyA);
	using registeredB = host.workingCopies.register(copyB);
	a.model.applyOperations([{ range: a.model.getFullModelRange(), text: 'unsaved' }]);
	b.model.applyOperations([{ range: b.model.getFullModelRange(), text: 'other unsaved' }]);
	assert.deepEqual(await host.transport.call('textDocument/list', { root: 'C:/workspace' }), { kind: 'documents', documents: [{ relativePath: 'open.txt', text: 'unsaved' }] });
	assert.equal(host.files.contents.get(inside.toString()), 'disk');
});

for (const scenario of [
	{ name: 'uppercase server drive', root: 'C:/workspace', resource: URI.file('c:/workspace/Folder/Mixed.txt'), relativePath: 'Folder/Mixed.txt' },
	{ name: 'uppercase editor drive', root: 'c:/workspace', resource: URI.file('C:/workspace/Folder/Mixed.txt'), relativePath: 'Folder/Mixed.txt' },
	{ name: 'encoded uppercase editor drive with matching server case', root: 'C:/workspace', resource: URI.parse('file:///%43:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'encoded uppercase editor drive with lowercase server drive', root: 'c:/workspace', resource: URI.parse('file:///%43:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'encoded lowercase editor drive with uppercase server drive', root: 'C:/workspace', resource: URI.parse('file:///%63:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'uppercase hexadecimal drive escape', root: 'j:/workspace', resource: URI.parse('file:///%4A:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'lowercase hexadecimal drive escape', root: 'J:/workspace', resource: URI.parse('file:///%4a:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'uppercase hexadecimal lowercase-drive escape', root: 'J:/workspace', resource: URI.parse('file:///%6A:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'lowercase hexadecimal lowercase-drive escape', root: 'j:/workspace', resource: URI.parse('file:///%6a:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'encoded drive separator remains reserved', root: 'C:/workspace', resource: URI.parse('file:///%43:%2Fworkspace/Mixed.txt') },
	{ name: 'encoded drive colon remains reserved', root: 'C:/workspace', resource: URI.parse('file:///%43%3A/workspace/Mixed.txt') },
	{ name: 'encoded drive preserves encoded directory separator', root: 'C:/workspace', resource: URI.parse('file:///%43:/workspace%2Fother/Mixed.txt') },
	{ name: 'encoded drive preserves encoded backslash', root: 'C:/workspace', resource: URI.parse('file:///%43:/workspace%5Cother/Mixed.txt') },
	{ name: 'encoded reserved character is not a drive letter', root: 'C:/workspace', resource: URI.parse('file:///%2F:/workspace/Mixed.txt') },
	{ name: 'drive root', root: 'C:/', resource: URI.file('c:/Folder/Mixed.txt'), relativePath: 'Folder/Mixed.txt' },
	{ name: 'trailing root separator', root: 'C:/workspace/', resource: URI.file('c:/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'POSIX root', root: '/', resource: URI.file('/workspace/Mixed.txt'), relativePath: 'workspace/Mixed.txt' },
	{ name: 'POSIX matching case', root: '/Workspace', resource: URI.file('/Workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'POSIX distinct case', root: '/Workspace', resource: URI.file('/workspace/Mixed.txt') },
	{ name: 'drive directory case remains distinct', root: 'C:/Workspace', resource: URI.file('c:/workspace/Mixed.txt') },
	{ name: 'sibling directory boundary', root: 'C:/workspace', resource: URI.file('c:/workspace-other/Mixed.txt') },
	{ name: 'different drive', root: 'C:/workspace', resource: URI.file('d:/workspace/Mixed.txt') },
	{ name: 'UNC same authority', root: '//SERVER/share/workspace', resource: URI.file('//server/share/workspace/Mixed.txt'), relativePath: 'Mixed.txt' },
	{ name: 'UNC different authority', root: '//server/share/workspace', resource: URI.file('//other/share/workspace/Mixed.txt') },
	{ name: 'UNC share boundary', root: '//server/share', resource: URI.file('//server/share-other/Mixed.txt') },
	{ name: 'UNC path case remains distinct', root: '//server/Share', resource: URI.file('//server/share/Mixed.txt') },
	{ name: 'different scheme', root: '/workspace', resource: URI.from({ scheme: Schemas.untitled, path: '/workspace/Mixed.txt' }) },
	{ name: 'query identity', root: 'C:/workspace', resource: URI.file('c:/workspace/Mixed.txt').with({ query: 'version=1' }) },
	{ name: 'fragment identity', root: 'C:/workspace', resource: URI.file('c:/workspace/Mixed.txt').with({ fragment: 'revision' }) },
	{ name: 'encoded separator stays inside its segment', root: 'C:/workspace', resource: URI.parse('file:///C:/workspace%2Fother/Mixed.txt') },
]) {
	test('document search snapshots respect ' + scenario.name, async () => {
		using host = await fixture();
		const resource = scenario.resource.scheme === Schemas.file ? scenario.resource : URI.file('/document-list-fixture.txt');
		host.files.contents.set(resource.toString(), 'disk');
		using reference = await host.models.acquire({ resource }, new AbortController().signal);
		using copy = workingCopy(reference);
		using registration = host.workingCopies.register({ ...copy, resource: scenario.resource, get isDirty() { return reference.isDirty; } });
		reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'unsaved' }]);
		assert.deepEqual(await host.transport.call('textDocument/list', { root: scenario.root }), {
			kind: 'documents',
			documents: scenario.relativePath === undefined ? [] : [{ relativePath: scenario.relativePath, text: 'unsaved' }],
		});
		assert.equal(host.files.contents.get(resource.toString()), 'disk');
	});
}

test('document search snapshots exclude clean text and dirty structured documents', async () => {
	using host = await fixture();
	using lifetime = new DisposableStore();
	for (const [name, backupKind, dirty] of [['clean.txt', 'text', false], ['structured.json', 'structuredDocument', true]] as const) {
		const resource = URI.file('/workspace/' + name);
		host.files.contents.set(resource.toString(), 'disk');
		const reference = lifetime.add(await host.models.acquire({ resource }, new AbortController().signal));
		const copy = lifetime.add(workingCopy(reference));
		lifetime.add(host.workingCopies.register({ ...copy, backupKind, get isDirty() { return reference.isDirty; } }));
		if (dirty) { reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'unsaved' }]); }
	}
	assert.deepEqual(await host.transport.call('textDocument/list', { root: '/workspace' }), { kind: 'documents', documents: [] });
});

test('a failed save reports a committed edit without losing the model or undo history', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/open.txt');
	host.files.contents.set(resource.toString(), 'disk');
	using reference = await host.models.acquire({ resource }, new AbortController().signal);
	using copy = workingCopy(reference);
	copy.save = async () => { throw new Error('Save failed'); };
	using registration = host.workingCopies.register(copy);
	const id = await snapshot(host.transport, resource);
	const result = await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: 'agent' }] });
	assert.equal(result.kind, 'outcomeUnknown');
	assert.equal(reference.model.getText(), 'agent');
	assert.equal(reference.isDirty, true);
	assert.equal(host.files.contents.get(resource.toString()), 'disk');
	assert.ok(reference.model.undo());
	assert.equal(reference.model.getText(), 'disk');
});

for (const eol of ['\n', '\r\n']) {
	test(`document protocol reads unsaved content and saves Agent edits and preserves earlier undo history (${JSON.stringify(eol)})`, async () => {
		using host = await fixture();
		const resource = URI.file('c:/workspace/open.txt');
		host.files.contents.set(resource.toString(), '\uFEFFdisk' + eol);
		using reference = await host.models.acquire({ resource }, new AbortController().signal);
		using copy = workingCopy(reference);
		using registered = host.workingCopies.register(copy);
		reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'unsaved' + eol }]);
		const read = await host.transport.call('textDocument/read', { path: resource.fsPath });
		assert.equal(read.kind, 'document', JSON.stringify(read));
		if (read.kind !== 'document') { throw new Error('Expected document'); }
		assert.equal(read.text, 'unsaved' + eol);
		assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: read.snapshot, text: 'agent\n' }] }), { kind: 'applied' });
		assert.equal(reference.model.getText(), 'agent' + eol);
		assert.equal(reference.isDirty, false);
		assert.equal(host.files.contents.get(resource.toString()), '\uFEFFagent' + eol);
		assert.ok(reference.model.undo());
		assert.equal(reference.model.getText(), 'unsaved' + eol);
		assert.ok(reference.model.undo());
		assert.equal(reference.model.getText(), 'disk' + eol);
	});
	test(`closed document edits save BOM and EOL and release the model after review (${JSON.stringify(eol)})`, async () => {
		using host = await fixture();
		const resource = URI.file('c:/workspace/closed.txt');
		host.files.contents.set(resource.toString(), '\uFEFFdisk' + eol);
		const id = await snapshot(host.transport, resource);
		assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'update', snapshot: id, text: 'agent\n' }] }), { kind: 'applied' });
		assert.equal(host.files.contents.get(resource.toString()), '\uFEFFagent' + eol);
		assert.equal(host.editing.entries.length, 1);
		await host.editing.accept(resource);
		assert.equal(host.models.getModel(resource), null);
	});
}

test('stale documents reject the entire transaction and consume its snapshots', async () => {
	using host = await fixture();
	const first = URI.file('c:/workspace/first.txt');
	const second = URI.file('c:/workspace/second.txt');
	for (const resource of [first, second]) { host.files.contents.set(resource.toString(), 'original'); }
	const a = await snapshot(host.transport, first);
	const b = await snapshot(host.transport, second);
	using reference = await host.models.acquire({ resource: second }, new AbortController().signal);
	reference.model.applyOperations([{ range: new Range(1, 1, 1, 1), text: 'user ' }]);
	const changes = [{ kind: 'update' as const, snapshot: a, text: 'agent' }, { kind: 'update' as const, snapshot: b, text: 'agent' }];
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes }), { kind: 'conflict' });
	assert.equal(host.files.contents.get(first.toString()), 'original');
	assert.equal(reference.model.getText(), 'user original');
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes }), { kind: 'conflict' });
	assert.equal(host.models.getModel(first), null);
});

test('repeated reads replace leases and connection close releases them', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/one.txt');
	host.files.contents.set(resource.toString(), 'original');
	const old = await snapshot(host.transport, resource);
	const current = await snapshot(host.transport, resource);
	assert.notEqual(old, current);
	await host.transport.call('textDocument/release', { snapshots: [old] });
	assert.notEqual(host.models.getModel(resource), null);
	host.client.disconnect();
	assert.equal(host.models.getModel(resource), null);
});

test('new file contents retain exact LF and BOM and roll back on a later move failure', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/new.txt');
	const existing = URI.file('c:/workspace/old.txt');
	host.files.contents.set(existing.toString(), 'original');
	const id = await snapshot(host.transport, existing);
	host.files.failRename = true;
	const failed = await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'create', path: resource.fsPath, text: '\uFEFFnew\n' }, { kind: 'move', snapshot: id, target: 'c:/workspace/moved.txt', text: 'original' }] });
	assert.equal(failed.kind, 'failed');
	assert.equal(host.files.contents.has(resource.toString()), false);
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'review-turn', changes: [{ kind: 'create', path: resource.fsPath, text: '\uFEFFnew\n' }] }), { kind: 'applied' });
	assert.equal(host.files.contents.get(resource.toString()), '\uFEFFnew\n');
});


test('deleting a BOM document restores its original bytes when a later operation fails', async () => {
	using host = await fixture();
	const first = URI.file('c:/workspace/deleted.txt');
	const second = URI.file('c:/workspace/moving.txt');
	host.files.contents.set(first.toString(), '\uFEFForiginal\r\n');
	host.files.contents.set(second.toString(), 'other');
	const a = await snapshot(host.transport, first);
	const b = await snapshot(host.transport, second);
	host.files.failRename = true;
	const result = await host.transport.call('textDocument/apply', {
		threadId: 'review-thread', turnId: 'review-turn', changes: [
			{ kind: 'delete', snapshot: a },
			{ kind: 'move', snapshot: b, target: 'c:/workspace/new.txt', text: 'other' },
		]
	});
	assert.equal(result.kind, 'failed');
	assert.equal(host.files.contents.get(first.toString()), '\uFEFForiginal\r\n');
});

test('a changed BOM document moves with its serialized format', async () => {
	using host = await fixture();
	const source = URI.file('c:/workspace/source.txt');
	const target = URI.file('c:/workspace/target.txt');
	host.files.contents.set(source.toString(), '\uFEFForiginal\r\n');
	const id = await snapshot(host.transport, source);
	const result = await host.transport.call('textDocument/apply', {
		threadId: 'review-thread', turnId: 'review-turn', changes: [
			{ kind: 'move', snapshot: id, target: target.fsPath, text: 'moved\n' },
		]
	});
	assert.deepEqual(result, { kind: 'applied' });
	assert.equal(host.files.contents.get(target.toString()), '\uFEFFmoved\r\n');
	assert.equal(host.files.contents.has(source.toString()), false);
});


test('closing during model resolution releases the late model reference', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/late.txt');
	host.files.contents.set(resource.toString(), 'original');
	let allowRead!: () => void;
	let started!: () => void;
	const reading = new Promise<void>(resolve => { started = resolve; });
	const gate = new Promise<void>(resolve => { allowRead = resolve; });
	const readBytes = host.files.readFile.bind(host.files);
	host.files.readFile = async value => { started(); await gate; return readBytes(value); };
	let released!: () => void;
	const removed = new Promise<void>(resolve => { released = resolve; });
	using listener = host.models.onModelRemoved(released);
	void host.transport.call('textDocument/read', { path: resource.fsPath });
	await reading;
	host.client.disconnect();
	allowRead();
	await removed;
	assert.equal(host.models.getModel(resource), null);
});


async function createReview(host: Awaited<ReturnType<typeof fixture>>, name: string, turnId = 'review-turn') {
	const resource = URI.file('c:/workspace/' + name);
	assert.deepEqual(await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId, changes: [{ kind: 'create', path: resource.fsPath, text: 'agent' }] }), { kind: 'applied' });
	return host.editing.entries.find(entry => entry.resources.some(uri => uri.toString() === resource.toString()))!;
}

async function flushReviews(host: Awaited<ReturnType<typeof fixture>>) {
	await host.editing.finishTurn({ threadId: 'unrelated', turnId: 'unrelated' }, 'completed');
}

test('automatic acceptance defaults to manual and validates the complete supported range', async () => {
	using host = await fixture();
	assert.equal(host.configuration.getValue('chat.editing.autoAcceptDelay'), 0);
	for (const value of [-1, 101, NaN, Infinity, '5']) {
		await assert.rejects(host.configuration.updateValue('chat.editing.autoAcceptDelay', value));
	}
	await host.configuration.updateValue('chat.editing.autoAcceptDelay', 100);
	await host.configuration.updateValue('chat.editing.autoAcceptDelay', 0);
	const entry = await createReview(host, 'manual.txt');
	host.transport.finishTurn('review-thread', 'review-turn');
	await flushReviews(host);
	assert.equal(host.editing.getAutoAcceptCountdown(entry), undefined);
	assert.equal(host.editing.entries.length, 1);
});

test('automatic acceptance waits for its exact reply and accepts the entire atomic operation', async () => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
	try {
		using host = await fixture();
		await host.configuration.updateValue('chat.editing.autoAcceptDelay', 2);
		const entry = await createReview(host, 'automatic.txt');
		mock.timers.tick(10000);
		host.transport.finishTurn('other-thread', 'review-turn');
		await flushReviews(host);
		assert.equal(host.editing.getAutoAcceptCountdown(entry), undefined);
		host.transport.finishTurn('review-thread', 'review-turn');
		await flushReviews(host);
		assert.equal(host.editing.getAutoAcceptCountdown(entry), 2);
		mock.timers.tick(1000);
		assert.equal(host.editing.getAutoAcceptCountdown(entry), 1);
		host.transport.finishTurn('review-thread', 'review-turn');
		await flushReviews(host);
		assert.equal(host.editing.getAutoAcceptCountdown(entry), 1);
		mock.timers.tick(1000);
		await flushReviews(host);
		assert.equal(host.editing.entries.length, 0);
		assert.equal([...host.files.contents.values()][0], 'agent');
	} finally { mock.timers.reset(); }
});

test('cancelling automatic acceptance retains review and a later tool starts a fresh reply lifecycle', async () => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
	try {
		using host = await fixture();
		await host.configuration.updateValue('chat.editing.autoAcceptDelay', 1);
		const entry = await createReview(host, 'cancel.txt');
		host.transport.finishTurn('review-thread', 'review-turn');
		await flushReviews(host);
		host.editing.cancelAutoAccept(entry);
		await host.configuration.updateValue('chat.editing.autoAcceptDelay', 2);
		mock.timers.tick(5000);
		await flushReviews(host);
		assert.equal(host.editing.entries.length, 1);
		const resource = entry.modifiedURI;
		const id = await snapshot(host.transport, resource);
		await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'next-turn', changes: [{ kind: 'update', snapshot: id, text: 'next agent' }] });
		const nextEntry = host.editing.entries[0]!;
		assert.equal(host.editing.getAutoAcceptCountdown(nextEntry), undefined);
		host.transport.finishTurn('review-thread', 'next-turn');
		await flushReviews(host);
		assert.equal(host.editing.getAutoAcceptCountdown(nextEntry), 2);
		await host.editing.rejectEntry(nextEntry);
		assert.equal(host.files.contents.has(resource.toString()), false);
	} finally { mock.timers.reset(); }
});

for (const outcome of ['failed', 'interrupted'] as const) {
	test('a ' + outcome + ' reply leaves edits available for manual review', async () => {
		using host = await fixture();
		await host.configuration.updateValue('chat.editing.autoAcceptDelay', 1);
		const entry = await createReview(host, outcome + '.txt');
		host.transport.finishTurn('review-thread', 'review-turn', outcome);
		await flushReviews(host);
		assert.equal(host.editing.getAutoAcceptCountdown(entry), undefined);
		await host.editing.rejectEntry(entry);
		assert.equal(host.editing.entries.length, 0);
	});
}

test('an atomic review waits for every contributing reply while unrelated files remain independent', async () => {
	using host = await fixture();
	await host.configuration.updateValue('chat.editing.autoAcceptDelay', 5);
	const original = await createReview(host, 'shared.txt', 'first-turn');
	const independent = await createReview(host, 'independent.txt', 'other-turn');
	const id = await snapshot(host.transport, original.modifiedURI);
	await host.transport.call('textDocument/apply', { threadId: 'review-thread', turnId: 'second-turn', changes: [{ kind: 'update', snapshot: id, text: 'second' }] });
	const shared = host.editing.entries.find(entry => entry.modifiedURI.toString() === original.modifiedURI.toString())!;
	host.transport.finishTurn('review-thread', 'second-turn');
	host.transport.finishTurn('review-thread', 'other-turn');
	await flushReviews(host);
	assert.equal(host.editing.getAutoAcceptCountdown(shared), undefined);
	assert.equal(host.editing.getAutoAcceptCountdown(independent), 5);
	host.transport.finishTurn('review-thread', 'first-turn');
	await flushReviews(host);
	assert.equal(host.editing.getAutoAcceptCountdown(shared), 5);
});

test('disabling automatic acceptance wins over a timer already queued behind another operation', async () => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
	try {
		using host = await fixture();
		await host.configuration.updateValue('chat.editing.autoAcceptDelay', 1);
		const entry = await createReview(host, 'disable.txt');
		host.transport.finishTurn('review-thread', 'review-turn');
		await flushReviews(host);
		const gate = new DeferredPromise<void>();
		const started = new DeferredPromise<void>();
		const apply = host.bulk.apply.bind(host.bulk);
		host.bulk.apply = async (edit, options) => { void started.complete(); await gate.p; return apply(edit, options); };
		const write = createReview(host, 'other-write.txt', 'other-turn');
		await started.p;
		mock.timers.tick(1000);
		await host.configuration.updateValue('chat.editing.autoAcceptDelay', 0);
		void gate.complete();
		await write;
		await flushReviews(host);
		assert.equal(host.editing.entries.includes(entry), true);
		assert.equal(host.editing.getAutoAcceptCountdown(entry), undefined);
	} finally { mock.timers.reset(); }
});

test('closing the review service disposes its scheduled countdown', async () => {
	mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
	try {
		const host = await fixture();
		await host.configuration.updateValue('chat.editing.autoAcceptDelay', 1);
		await createReview(host, 'dispose.txt');
		host.transport.finishTurn('review-thread', 'review-turn');
		await flushReviews(host);
		host.dispose();
		mock.timers.tick(5000);
		assert.equal(host.editing.entries.length, 0);
	} finally { mock.timers.reset(); }
});
