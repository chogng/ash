import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { IBulkEditService } from '../../../../../editor/browser/services/bulkEditService.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { AppServerProtocolClient } from '../../../../../platform/app-server/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../../../platform/app-server/common/appServerTransport.js';
import { APP_SERVER_SCHEMA_HASH, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION, APP_SERVER_CAPABILITY_VERSION, type InitializeResult, type ServerCapabilities, type AppServerServerRequestMethod, type ServerRequestParams, type ServerRequestResult } from '../../../../../platform/app-server/common/generated/index.js';
import { FileKind, FileNotFoundError, FileRevisionConflictError, type IFileService, type IFileWriteRequest, type FileExistingTargetBehavior } from '../../../../../platform/files/common/files.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { BrowserTextResourceStore } from '../../../../contrib/codeEditor/browser/browserTextResourceStore.js';
import { BrowserBulkEditService } from '../../../../contrib/bulkEdit/browser/bulkEditService.js';
import { BrowserWorkspaceEditService } from '../../../language/browser/browserWorkspaceEditService.js';
import { BrowserTextModelService } from '../../../textmodelResolver/browser/browserTextModelService.js';
import { ITextModelResourceService } from '../../../textmodelResolver/common/textModelResourceService.js';
import { TextModelResolverService } from '../../../textmodelResolver/common/textModelResolverService.js';
import { BrowserWorkingCopyService } from '../../../workingCopy/browser/browserWorkingCopyService.js';
import { IWorkingCopyService, type IWorkingCopy } from '../../../workingCopy/common/workingCopyService.js';
import { TextFileService } from '../../common/textFileService.js';
import { AppServerTextDocumentHost } from '../../browser/appServerTextDocumentHost.js';

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
	public call<M extends AppServerServerRequestMethod>(method: M, params: ServerRequestParams<M>): Promise<ServerRequestResult<M>> {
		const id = `client-host:7:${++this.sequence}`;
		const reply = new Promise<ServerRequestResult<M>>(resolve => this.replies.set(id, result => resolve(result as ServerRequestResult<M>)));
		this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
		return reply;
	}
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'test', workspaceRoot: '/workspace' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string }).frame) as { id: number | string; method?: string; result?: unknown; error?: unknown };
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
			result = { serverInfo: { name: 'ash-app-server', version: '1' }, protocolVersion: { major: APP_SERVER_PROTOCOL_MAJOR, revision: APP_SERVER_PROTOCOL_REVISION }, schemaHash: APP_SERVER_SCHEMA_HASH, capabilities: { ...capabilities, contracts: { sessions: { version: APP_SERVER_CAPABILITY_VERSION }, threads: { version: APP_SERVER_CAPABILITY_VERSION }, turns: { version: APP_SERVER_CAPABILITY_VERSION }, memoryDiagnostics: { version: 1 } } }, slashCommands: [] } satisfies InitializeResult;

			this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
		} else if (typeof request.id === 'string') {
			this.replies.get(request.id)?.(request.result ?? request.error);
			this.replies.delete(request.id);
		}
	}
}

class Files extends Disposable implements IFileService {
	private readonly changes = this._register(new Emitter<{ resources: readonly URI[] }>());
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
	public async readFile(resource: URI) { await this.stat(resource); const content = this.contents.get(resource.toString())!; return { resource, content, revision: content }; }
	public async readFileBytes(resource: URI) { const result = await this.readFile(resource); return { resource, bytes: new TextEncoder().encode(result.content), revision: result.revision }; }
	public async writeFile(request: IFileWriteRequest) {
		if (request.expectedRevision !== undefined && request.expectedRevision !== this.contents.get(request.resource.toString())) { throw new FileRevisionConflictError(request.resource); }
		this.contents.set(request.resource.toString(), request.content);
		return { stat: await this.stat(request.resource), revision: request.content };
	}
	public async writeFileBytes(resource: URI, bytes: Uint8Array) { return this.writeFile({ resource, content: new TextDecoder('utf8', { ignoreBOM: true }).decode(bytes) }); }
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
		this.contents.set(target.toString(), content.content);
	}
	public async delete(resource: URI): Promise<void> { this.contents.delete(resource.toString()); }
}

async function fixture() {
	const lifetime = new DisposableStore();
	const files = lifetime.add(new Files());
	const models = lifetime.add(new BrowserTextModelService(new BrowserTextResourceStore(new TextFileService(files))));
	const workingCopies = lifetime.add(new BrowserWorkingCopyService());
	const edits = lifetime.add(new BrowserWorkspaceEditService(models, workingCopies, files));
	const bulk = lifetime.add(new BrowserBulkEditService(edits));
	const services = lifetime.add(new InstantiationService());
	services.registerInstance(ITextModelResourceService, models);
	services.registerInstance(IBulkEditService, bulk);
	services.registerInstance(IWorkingCopyService, workingCopies);
	services.registerSingleton(ITextModelService, () => services.createInstance(TextModelResolverService));
	const transport = new Transport();
	const client = new AppServerProtocolClient(transport);
	lifetime.add(toDisposable(() => client.dispose()));
	lifetime.add(services.createInstance(AppServerTextDocumentHost, client));
	await client.connect();
	return { files, models, workingCopies, services, transport, client, ...toDisposable(() => lifetime.dispose()) };
}

async function snapshot(transport: Transport, resource: URI): Promise<string> {
	const result = await transport.call('textDocument/read', { path: resource.fsPath });
	assert.equal(result.kind, 'document', JSON.stringify(result));
	if (result.kind !== 'document') { throw new Error('Document was not resolved'); }
	return result.snapshot;
}

function workingCopy(reference: Awaited<ReturnType<BrowserTextModelService['acquire']>>): IWorkingCopy {
	return { resource: reference.resource, backupKind: 'text', get isDirty() { return reference.isDirty; }, get hasExternalChange() { return reference.hasExternalChange; }, onDidChangeDirty: reference.onDidChangeDirty, onDidChangeExternalChange: reference.onDidChangeExternalChange, onDidChangeContent: listener => reference.model.onDidChangeContent(() => listener()), backup: () => reference.model.getText(), restoreBackup: content => reference.model.reset(content), save: signal => reference.save(signal), saveAs: async () => {}, revert: signal => reference.revert(signal), ...toDisposable(() => {}) };
}

test('document search snapshots contain only unsaved text within the requested directory', async () => {
	using host = await fixture();
	const inside = URI.file('c:/workspace/open.txt');
	const outside = URI.file('c:/workspace-other/open.txt');
	host.files.contents.set(inside.toString(), 'disk');
	host.files.contents.set(outside.toString(), 'outside');
	using a = await host.models.acquire({ resource: inside }, new AbortController().signal);
	using b = await host.models.acquire({ resource: outside }, new AbortController().signal);
	using registeredA = host.workingCopies.register(workingCopy(a));
	using registeredB = host.workingCopies.register(workingCopy(b));
	a.model.applyOperations([{ range: a.model.getFullModelRange(), text: 'unsaved' }]);
	b.model.applyOperations([{ range: b.model.getFullModelRange(), text: 'other unsaved' }]);
	assert.deepEqual(await host.transport.call('textDocument/list', { root: 'C:/workspace' }), { kind: 'documents', documents: [{ relativePath: 'open.txt', text: 'unsaved' }] });
	assert.equal(host.files.contents.get(inside.toString()), 'disk');
});

test('a failed save reports a committed edit without losing the model or undo history', async () => {
	using host = await fixture();
	const resource = URI.file('c:/workspace/open.txt');
	host.files.contents.set(resource.toString(), 'disk');
	using reference = await host.models.acquire({ resource }, new AbortController().signal);
	const copy = workingCopy(reference);
	copy.save = async () => { throw new Error('Save failed'); };
	using registration = host.workingCopies.register(copy);
	const id = await snapshot(host.transport, resource);
	const result = await host.transport.call('textDocument/apply', { changes: [{ kind: 'update', snapshot: id, text: 'agent' }] });
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
		using registered = host.workingCopies.register(workingCopy(reference));
		reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: 'unsaved' + eol }]);
		const read = await host.transport.call('textDocument/read', { path: resource.fsPath });
		assert.equal(read.kind, 'document', JSON.stringify(read));
		if (read.kind !== 'document') { throw new Error('Expected document'); }
		assert.equal(read.text, 'unsaved' + eol);
		assert.deepEqual(await host.transport.call('textDocument/apply', { changes: [{ kind: 'update', snapshot: read.snapshot, text: 'agent\n' }] }), { kind: 'applied' });
		assert.equal(reference.model.getText(), 'agent' + eol);
		assert.equal(reference.isDirty, false);
		assert.equal(host.files.contents.get(resource.toString()), '\uFEFFagent' + eol);
		assert.ok(reference.model.undo());
		assert.equal(reference.model.getText(), 'unsaved' + eol);
		assert.ok(reference.model.undo());
		assert.equal(reference.model.getText(), 'disk' + eol);
	});
	test(`closed document edits save BOM and EOL then release the model (${JSON.stringify(eol)})`, async () => {
		using host = await fixture();
		const resource = URI.file('c:/workspace/closed.txt');
		host.files.contents.set(resource.toString(), '\uFEFFdisk' + eol);
		const id = await snapshot(host.transport, resource);
		assert.deepEqual(await host.transport.call('textDocument/apply', { changes: [{ kind: 'update', snapshot: id, text: 'agent\n' }] }), { kind: 'applied' });
		assert.equal(host.files.contents.get(resource.toString()), '\uFEFFagent' + eol);
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
	assert.deepEqual(await host.transport.call('textDocument/apply', { changes }), { kind: 'conflict' });
	assert.equal(host.files.contents.get(first.toString()), 'original');
	assert.equal(reference.model.getText(), 'user original');
	assert.deepEqual(await host.transport.call('textDocument/apply', { changes }), { kind: 'conflict' });
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
	const failed = await host.transport.call('textDocument/apply', { changes: [{ kind: 'create', path: resource.fsPath, text: '\uFEFFnew\n' }, { kind: 'move', snapshot: id, target: 'c:/workspace/moved.txt', text: 'original' }] });
	assert.equal(failed.kind, 'failed');
	assert.equal(host.files.contents.has(resource.toString()), false);
	assert.deepEqual(await host.transport.call('textDocument/apply', { changes: [{ kind: 'create', path: resource.fsPath, text: '\uFEFFnew\n' }] }), { kind: 'applied' });
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
	const result = await host.transport.call('textDocument/apply', { changes: [
		{ kind: 'delete', snapshot: a },
		{ kind: 'move', snapshot: b, target: 'c:/workspace/new.txt', text: 'other' },
	] });
	assert.equal(result.kind, 'failed');
	assert.equal(host.files.contents.get(first.toString()), '\uFEFForiginal\r\n');
});

test('a changed BOM document moves with its serialized format', async () => {
	using host = await fixture();
	const source = URI.file('c:/workspace/source.txt');
	const target = URI.file('c:/workspace/target.txt');
	host.files.contents.set(source.toString(), '\uFEFForiginal\r\n');
	const id = await snapshot(host.transport, source);
	const result = await host.transport.call('textDocument/apply', { changes: [
		{ kind: 'move', snapshot: id, target: target.fsPath, text: 'moved\n' },
	] });
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
	const readBytes = host.files.readFileBytes.bind(host.files);
	host.files.readFileBytes = async value => { started(); await gate; return readBytes(value); };
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
