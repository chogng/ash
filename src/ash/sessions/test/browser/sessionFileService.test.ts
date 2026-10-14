import { QueryBuilder } from '../../../workbench/services/search/common/queryBuilder.js';
import { SearchService } from '../../../workbench/services/search/common/searchService.js';
import { BulkEditTestServices } from '../../../workbench/contrib/bulkEdit/test/browser/bulkEditTestServices.js';
import { WorkspaceContextService } from '../../../workbench/services/workspaces/browser/workspaceContextService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { DeferredPromise } from '../../../base/common/async.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { createDisconnectedRendererApi } from '../../../workbench/browser/rendererApi.js';
import type { IRendererHost } from '../../../platform/renderer/common/rendererHost.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { ISessionsService, SessionsService } from '../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { SessionsManagementService } from '../../services/sessions/browser/sessionsManagementService.js';
import type { ISessionsProvider } from '../../services/sessions/common/sessionsProvider.js';
import type { ISession, SessionId } from '../../services/sessions/common/session.js';
import { SessionsWorkspaceContextService } from '../../services/workspace/browser/workspaceContextService.js';
import { SessionFileService } from '../../contrib/providers/agentHost/browser/sessionFileService.js';
import { CustomViewService, ICustomViewService } from '../../services/customView/browser/customViewService.js';
import { NullLoggerService } from '../../../platform/log/common/log.js';

test('Session files preserve their original directory through selection, directory moves and archive', async () => {
	const browser = new JSDOM('<!doctype html>', { url: 'https://sessions.test' });
	try {
		using services = new InstantiationService();
		using provider = new MemoryProvider();
		using management = new SessionsManagementService(provider);
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
		services.registerInstance(ISessionsManagementService, management);
		services.registerInstance(IStorageService, storage);
		using customViews = new CustomViewService(new NullLoggerService(), storage);
		services.registerInstance(ICustomViewService, customViews);
		using sessions = services.createInstance(SessionsService);
		services.registerInstance(ISessionsService, sessions);
		await sessions.initialize();
		using workspace = services.createInstance(SessionsWorkspaceContextService, () => ({ id: 'host', folders: [] }));
		services.registerInstance(IWorkspaceContextService, workspace);
		const calls: unknown[] = [];
		const host = createDisconnectedRendererApi();
		const fileHost: IRendererHost = {
			...host, fileSearch: {
				glob: async (directory, query, signal) => { calls.push({ target: directory.target, query, aborted: signal?.aborted }); return { matches: [], totalMatches: 0 }; },
				fuzzy: async (directory, query, signal) => { calls.push({ target: directory.target, query, aborted: signal?.aborted }); return { matches: [], totalMatches: 0 }; },
			}, fs: {
				...host.fs,
				readPathCaseSensitivity: async params => { calls.push(params); return { scopes: [{ path: '.', sensitivity: 'insensitive' }] }; },
				readBinaryFile: async params => { calls.push(params); return { resource: { resourceId: 'file', mimeType: 'text/plain', size: 8, sha256: 'sha256:file' }, revision: 'rev-1' }; },
				writeFileElevated: async () => { throw new Error('Unexpected elevated write'); },
				writeBinaryFile: async params => { calls.push(params); return { revision: 'rev-2', metadata: { fileType: 'file', readonly: false, sizeBytes: 7, modifiedAtMillis: null } }; },
				copy: async params => { calls.push(params); },
				pasteSystemFiles: async params => { calls.push(params); return true; },
			},
			resource: {
				...host.resource,
				read: async () => ({ resourceId: 'file', offset: 0, dataBase64: 'b3JpZ2luYWw=', decodedLength: 8, eof: true }),
				release: async () => { },
			},
		};
		using files = services.createInstance(SessionFileService, fileHost);
		const restoredRoot = 'C:/managed/restored';
		provider.items[0] = {
			...provider.items[0]!,
			chats: [...provider.items[0]!.chats, { threadId: 'restored-thread', status: 'active', origin: { type: 'fork', parentThreadId: 'first-thread', parentSequence: 1 }, workspace: { authorityId: 'local', root: restoredRoot } }],
		};
		await sessions.openThread('first', 'restored-thread');
		assert.equal(workspace.getWorkspace().folders[0]!.uri.toString(), URI.file(restoredRoot).toString());
		await files.readFile(URI.file(`${restoredRoot}/main.ts`));
		assert.deepEqual(calls.pop(), { sessionDirectory: { sessionId: 'first', path: restoredRoot }, path: 'main.ts' });
		await sessions.openThread('first', 'first-thread');
		const originalFolder = workspace.getWorkspace().folders[0]!;
		const first = URI.file('C:/sessions/first/main.ts');
		await files.resolvePathIdentity(first);
		await files.readFile(first);
		sessions.openSession('second', 'second-thread');
		assert.equal(workspace.getWorkspace().folders[0]!.uri.toString(), URI.file('C:/sessions/second').toString());
		await files.writeFile(first, new TextEncoder().encode('updated'), { create: true, overwrite: true, expectedRevision: 'rev-1' });
		provider.items = [session('first', 'C:/sessions/moved'), provider.items[1]!];
		await sessions.openThread('first', 'first-thread');
		await files.copy(first, first.with({ path: '/C:/sessions/first/copy.ts' }));
		await files.pasteSystemFiles(URI.file('C:/sessions/first'), false);
		await management.archiveSession('first');
		await files.readFile(first);
		const controller = new AbortController();
		await files.glob({ resource: originalFolder.uri, target: { type: 'workspace', dirId: originalFolder.id } }, { includePatterns: ['**/*.ts'], excludePatterns: [], maxResults: 100 }, controller.signal);
		await files.fuzzy({ resource: originalFolder.uri, target: { type: 'workspace', dirId: originalFolder.id } }, { query: 'MAIN', maxResults: 10 }, controller.signal);
		const owner = { sessionId: 'first', path: 'C:/sessions/first' };
		assert.deepEqual(calls, [
			{ sessionDirectory: owner, path: 'main.ts' },
			{ sessionDirectory: owner, path: 'main.ts' },
			{ sessionDirectory: owner, path: 'main.ts', dataBase64: 'dXBkYXRlZA==', options: { mode: 'createOrReplace', expectedRevision: 'rev-1' } },
			{ sessionDirectory: owner, source: 'main.ts', target: 'copy.ts' },
			{ sessionDirectory: owner, path: '.', moveRequested: false },
			{ sessionDirectory: owner, path: 'main.ts' },
			{ target: { type: 'session', ...owner }, query: { includePatterns: ['**/*.ts'], excludePatterns: [], maxResults: 100 }, aborted: false },
			{ target: { type: 'session', ...owner }, query: { query: 'MAIN', maxResults: 10 }, aborted: false },
		]);
		await assert.rejects(async () => files.copy(first, URI.file('C:/sessions/second/copied.ts')), /between Session/);
	} finally { browser.window.close(); }
});

class MemoryProvider extends Disposable implements ISessionsProvider {
	readonly id = 'test-provider';
	readonly label = 'Test provider';
	readonly order = 0;
	readonly onDidChangeCatalog = Event.None;
	private readonly changed = this._register(new Emitter<{ sessionId: SessionId; detailChanged: boolean; }>());
	readonly onDidChangeSession = this.changed.event;
	items = [session('first', 'C:/sessions/first'), session('second', 'C:/sessions/second')];
	async list() { return this.items; }
	async listAgents() { return []; }
	async readCatalog(id: SessionId) { return this.items.find(session => session.sessionId === id); }
	async subscribe(session: ISession): Promise<ISession> { const current = this.items.find(item => item.sessionId === session.sessionId)!; return { ...current, chats: current.chats.map(chat => ({ ...chat, workspace: chat.workspace ?? current.workspace ?? null })) }; }
	async unsubscribe() { }
	currentWorkspace() { return { type: 'current' as const }; }
	async create(): Promise<never> { throw new Error('This test uses durable sessions'); }
	async setModel() { }
	async archive(session: ISession): Promise<ISession> { return { ...session, status: 'archived' }; }
	async restore(session: ISession): Promise<ISession> { return { ...session, status: 'active' }; }
	async stop(session: ISession) { return session; }
	async interrupt() { }
}

function session(id: string, root: string): ISession {
	return { sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', workspace: { authorityId: 'local', root }, chats: [{ threadId: `${id}-thread`, status: 'active', origin: { type: 'root' } }] };
}


test('Workbench file and content search retain Session directory authorization at the provider boundary', async () => {
	const uri = URI.file('/sessions/first');
	const owner = { sessionId: 'first', path: uri.fsPath };
	const folder = { id: `session:${encodeURIComponent(owner.sessionId)}:${encodeURIComponent(owner.path)}`, name: 'first', index: 0, uri };
	using workspace = new WorkspaceContextService({ id: 'session', folders: [folder] });
	using services = new InstantiationService();
	services.registerInstance(IWorkspaceContextService, workspace);
	using provider = new MemoryProvider();
	using management = new SessionsManagementService(provider);
	services.registerInstance(ISessionsManagementService, management);
	using editing = new BulkEditTestServices([]);
	const host = createDisconnectedRendererApi();
	const calls: unknown[] = [];
	using files = services.createInstance(SessionFileService, {
		...host,
		fileSearch: {
			...host.fileSearch,
			async fuzzy(directory, query) {
				calls.push({ target: directory.target, query });
				return { matches: [{ path: 'main.ts', score: 40, resource: URI.joinPath(uri, 'main.ts') }], totalMatches: 1 };
			},
		},
		contentSearch: {
			async start(params) { calls.push(params); return { searchId: 'session-query' }; },
			async read(params) { calls.push(params); return { searchId: params.searchId, matches: [], nextMatch: 0, completed: true, limitHit: false, error: null }; },
			async cancel(params) { calls.push(params); },
		},
	} satisfies IRendererHost);
	const search = new SearchService(files, workspace, editing.models, files);
	const result = await search.fileSearch(new QueryBuilder().file([uri], { filePattern: 'main', sortByScore: true, maxResults: 1 }));
	assert.deepEqual(result.results.map(file => file.resource.toString()), [URI.joinPath(uri, 'main.ts').toString()]);
	await search.textSearch(new QueryBuilder().text({ pattern: 'needle' }, [uri]));
	assert.deepEqual(calls[0], { target: { type: 'session', ...owner }, query: { query: 'main', maxResults: 2 } });
	for (const call of calls.slice(1)) {
		assert.deepEqual((call as { sessionDirectory: unknown; }).sessionDirectory, owner);
		assert.equal('dirId' in (call as object), false);
	}
	assert.equal(calls.length, 4);
});


test('restored file identity waits for the real Session directory instead of reading the source workspace', async () => {
	const browser = new JSDOM('<!doctype html>', { url: 'https://sessions.test' });
	try {
		using services = new InstantiationService();
		using provider = new MemoryProvider();
		provider.items = [session('first', '/source')];
		const directory = new DeferredPromise<ISession>();
		provider.subscribe = async () => directory.p;
		using management = new SessionsManagementService(provider);
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'directory-restore', flushInterval: 0 });
		services.registerInstance(ISessionsManagementService, management);
		services.registerInstance(IStorageService, storage);
		using customViews = new CustomViewService(new NullLoggerService(), storage);
		services.registerInstance(ICustomViewService, customViews);
		using sessions = services.createInstance(SessionsService);
		services.registerInstance(ISessionsService, sessions);
		using workspace = services.createInstance(SessionsWorkspaceContextService, () => ({ id: 'source', folders: [{ id: 'source', index: 0, name: 'source', uri: URI.file('/source') }] }));
		services.registerInstance(IWorkspaceContextService, workspace);
		const calls: unknown[] = [];
		const host = createDisconnectedRendererApi();
		const fileHost: IRendererHost = { ...host, fs: { ...host.fs, readPathCaseSensitivity: async params => { calls.push(params); return { scopes: [{ path: '.', sensitivity: 'sensitive' }] }; } } };
		using files = services.createInstance(SessionFileService, fileHost);
		await sessions.initialize();
		const resource = URI.file('/managed/first/main.ts');
		const opening = files.resolvePathIdentity(resource).then(() => 'resolved', error => String(error));
		assert.deepEqual(calls, []);
		await directory.complete({ ...provider.items[0]!, chats: [{ ...provider.items[0]!.chats[0]!, workspace: { authorityId: 'local', root: '/managed/first' } }], agentTree: [] });
		assert.equal(await opening, 'resolved');
		assert.deepEqual(calls, [{ sessionDirectory: { sessionId: 'first', path: '/managed/first' }, path: 'main.ts' }]);
		await assert.rejects(files.resolvePathIdentity(URI.file('/outside/main.ts')), /Resource must belong to a current workspace folder/);
	} finally { browser.window.close(); }
});
