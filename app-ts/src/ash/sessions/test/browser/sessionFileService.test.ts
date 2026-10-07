import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { InstantiationService } from '../../../platform/instantiation/common/instantiationService.js';
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../platform/workspace/common/workspace.js';
import { createDisconnectedRendererApi } from '../../../platform/app-server/browser/rendererApi.js';
import type { IRendererHost } from '../../../platform/renderer/common/rendererHost.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { ISessionsService, SessionsService } from '../../services/sessions/browser/sessionsService.js';
import { ISessionsManagementService } from '../../services/sessions/common/sessionsManagement.js';
import { SessionsManagementService } from '../../services/sessions/browser/sessionsManagementService.js';
import type { ISessionsProvider } from '../../services/sessions/common/sessionsProvider.js';
import type { ISession, SessionId } from '../../services/sessions/common/session.js';
import { SessionsWorkspaceContextService } from '../../services/workspace/browser/workspaceContextService.js';
import { SessionFileService } from '../../contrib/providers/appServer/browser/sessionFileService.js';

test('Session files preserve their original directory through selection, directory moves and archive', async () => {
	const browser = new JSDOM('<!doctype html>', { url: 'https://sessions.test' });
	try {
		using services = new InstantiationService();
		using provider = new MemoryProvider();
		using management = new SessionsManagementService(provider);
		using storage = new BrowserStorageService({ ownerWindow: browser.window as unknown as Window, workspaceId: 'sessions', flushInterval: 0 });
		services.registerInstance(ISessionsManagementService, management);
		services.registerInstance(IStorageService, storage);
		using sessions = services.createInstance(SessionsService);
		services.registerInstance(ISessionsService, sessions);
		await sessions.initialize();
		using workspace = services.createInstance(SessionsWorkspaceContextService, () => ({ id: 'host', folders: [] }));
		services.registerInstance(IWorkspaceContextService, workspace);
		const calls: unknown[] = [];
		const host = createDisconnectedRendererApi();
		const fileHost: IRendererHost = {
			...host, fileSearch: { glob: async (directory, query, signal) => { calls.push({ target: directory.target, query, aborted: signal?.aborted }); return { matches: [], totalMatches: 0 }; } }, fs: {
				...host.fs,
				readFile: async params => { calls.push(params); return { content: 'original', revision: 'rev-1' }; },
				writeFile: async params => { calls.push(params); return { revision: 'rev-2', metadata: { fileType: 'file', readonly: false, sizeBytes: 7, modifiedAtMillis: null } }; },
				copy: async params => { calls.push(params); },
				pasteSystemFiles: async params => { calls.push(params); return true; },
			}
		};
		using files = services.createInstance(SessionFileService, fileHost);
		const originalFolder = workspace.getWorkspace().folders[0]!;
		const first = URI.file('C:/sessions/first/main.ts');
		await files.readFile(first);
		sessions.openSession('second', 'second-thread');
		assert.equal(workspace.getWorkspace().folders[0]!.uri.toString(), URI.file('C:/sessions/second').toString());
		await files.writeFile({ resource: first, content: 'updated', expectedRevision: 'rev-1' });
		provider.items = [session('first', 'C:/sessions/moved'), provider.items[1]!];
		await sessions.openThread('first', 'first-thread');
		await files.copy(first, first.with({ path: '/C:/sessions/first/copy.ts' }));
		await files.pasteSystemFiles(URI.file('C:/sessions/first'), false);
		await management.archiveSession('first');
		await files.readFile(first);
		const controller = new AbortController();
		await files.glob({ resource: originalFolder.uri, target: { type: 'workspace', dirId: originalFolder.id } }, { includePatterns: ['**/*.ts'], excludePatterns: [], maxResults: 100 }, controller.signal);
		const owner = { sessionId: 'first', path: 'C:/sessions/first' };
		assert.deepEqual(calls, [
			{ sessionDirectory: owner, path: 'main.ts' },
			{ sessionDirectory: owner, path: 'main.ts', content: 'updated', expectedRevision: 'rev-1' },
			{ sessionDirectory: owner, source: 'main.ts', target: 'copy.ts' },
			{ sessionDirectory: owner, path: '.', moveRequested: false },
			{ sessionDirectory: owner, path: 'main.ts' },
			{ target: { type: 'session', ...owner }, query: { includePatterns: ['**/*.ts'], excludePatterns: [], maxResults: 100 }, aborted: false },
		]);
		await assert.rejects(async () => files.copy(first, URI.file('C:/sessions/second/copied.ts')), /between Session/);
	} finally { browser.window.close(); }
});

class MemoryProvider extends Disposable implements ISessionsProvider {
	readonly onDidChangeCatalog = Event.None;
	private readonly changed = this._register(new Emitter<{ sessionId: SessionId; detailChanged: boolean; }>());
	readonly onDidChangeSession = this.changed.event;
	items = [session('first', 'C:/sessions/first'), session('second', 'C:/sessions/second')];
	async list() { return this.items; }
	async listAgents() { return []; }
	async readCatalog(id: SessionId) { return this.items.find(session => session.sessionId === id); }
	async subscribe(session: ISession) { return this.items.find(item => item.sessionId === session.sessionId)!; }
	async unsubscribe() { }
	currentWorkspace() { return { type: 'current' as const }; }
	async create(): Promise<never> { throw new Error('This test uses durable sessions'); }
	async setModel() { }
	async archive(session: ISession): Promise<ISession> { return { ...session, status: 'archived' }; }
	async stop(session: ISession) { return session; }
	async interrupt() { }
}

function session(id: string, root: string): ISession {
	return { sessionId: id, title: id, status: 'active', nextApprovalMode: 'manual', workspace: { authorityId: 'local', root }, chats: [{ threadId: `${id}-thread`, status: 'active', origin: { type: 'root' } }] };
}
