import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../base/common/async.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { AppServerFileSystemProvider } from '../../../agentHost/browser/appServerFileSystemProvider.js';
import { createDisconnectedRendererApi } from '../../../agentHost/browser/rendererApi.js';
import { createSshRemoteWorkspaceUri } from '../../../remote/common/remote.js';
import { IUriIdentityService } from '../../../uriIdentity/common/uriIdentity.js';
import { TestUriIdentityServices } from '../../../uriIdentity/test/common/uriIdentityTestServices.js';
import { WorkspaceContextService } from '../../../../workbench/services/workspaces/browser/workspaceContextService.js';
import { createTestTextFileService } from '../../../../workbench/test/common/testEditorServices.js';
import { BrowserTextResourceStore } from '../../../../workbench/contrib/codeEditor/browser/browserTextResourceStore.js';
import { BrowserTextModelService } from '../../../../workbench/services/textmodelResolver/browser/browserTextModelService.js';
import { FileService } from '../../common/fileService.js';
import type { FsChanged, FsReadPathCaseSensitivityResult } from '../../../../../../.build/protocol/typescript/index.js';

suite('App Server directory path identity', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('insensitive children retain sensitive parent identity, URI components and escaped separators', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		const host = createDisconnectedRendererApi();
		const requests: unknown[] = [];
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace, resourceApi: host.resource, api: {
				...host.fs, readPathCaseSensitivity: async params => {
					requests.push(params);
					return { scopes: [{ path: '.', sensitivity: 'sensitive' }, { path: params.path.split('/')[0], sensitivity: 'insensitive' }] };
				}
			}
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const first = URI.parse('file:///workspace/Parent/File.txt?view=1#one');
		await identity.resolveCanonicalUri(first);
		const alias = URI.parse('file:///workspace/Parent/FILE.txt?view=1#two');
		assert.equal((await identity.resolveCanonicalUri(alias)).toString(), first.with({ fragment: 'two' }).toString());
		const other = URI.file('/workspace/parent/File.txt');
		await identity.resolveCanonicalUri(other);
		assert.deepEqual([
			identity.extUri.isEqualIgnoringFragment(first, alias),
			identity.extUri.isEqualIgnoringFragment(first, other.with({ query: 'view=1' })),
			identity.extUri.isEqualIgnoringFragment(first, alias.with({ query: 'view=2' })),
			identity.extUri.isEqualOrParent(alias.with({ query: null, fragment: null }), URI.file('/workspace/Parent')),
			identity.extUri.isEqualOrParent(other, URI.file('/workspace/Parent')),
			identity.extUri.isEqual(URI.parse('file:///workspace/Parent/a%2Fb'), URI.file('/workspace/Parent/a/b')),
			identity.extUri.isEqualIgnoringFragment(first, URI.parse('file:///%77orkspace/%50arent/FILE.txt?view=1')),
			identity.extUri.isEqualIgnoringFragment(first, URI.parse('file:///WORKSPACE/Parent/FILE.txt?view=1')),
			identity.extUri.isEqual(URI.file('/workspace/Parent/İ.txt'), URI.file('/workspace/Parent/i\u0307.txt')),
		], [true, false, false, true, false, false, true, false, false]);
		await identity.resolveCanonicalUri(alias);
		assert.equal(requests.length, 3);
	});

	test('local and remote roots consume independent rules and unknown rules preserve differences', async () => {
		const local = URI.file('/local');
		const remote = createSshRemoteWorkspaceUri('server', '/remote');
		using workspace = new WorkspaceContextService({ id: 'multi', folders: [{ id: 'local', uri: local, name: 'local', index: 0 }, { id: 'remote', uri: remote, name: 'remote', index: 1 }] });
		const host = createDisconnectedRendererApi();
		using provider = new AppServerFileSystemProvider({ workspaceContextService: workspace, resourceApi: host.resource, api: { ...host.fs, readPathCaseSensitivity: async params => ({ scopes: [{ path: '.', sensitivity: params.dirId === 'local' ? 'insensitive' : 'unknown' }] }) } });
		using files = new FileService();
		using localRegistration = files.registerProvider(local.scheme, provider);
		using remoteRegistration = files.registerProvider(remote.scheme, provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		await identity.resolveCanonicalUri(local.joinPathSegment('File'));
		await identity.resolveCanonicalUri(remote.joinPathSegment('File'));
		assert.deepEqual([identity.extUri.isEqual(local.joinPathSegment('File'), local.joinPathSegment('FILE')), identity.extUri.isEqual(remote.joinPathSegment('File'), remote.joinPathSegment('FILE'))], [true, false]);
	});

	test('reconnection, workspace replacement and disposal discard late casing responses', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		using connection = new Emitter<void>();
		let generation = 1;
		let response = new DeferredPromise<FsReadPathCaseSensitivityResult>();
		const host = createDisconnectedRendererApi();
		using provider = new AppServerFileSystemProvider({ workspaceContextService: workspace, resourceApi: host.resource, api: { ...host.fs, get connectionGeneration() { return generation; }, onDidChangeConnection: connection.event, readPathCaseSensitivity: () => response.p } });
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const resource = root.joinPathSegment('File');
		const pending = identity.resolveCanonicalUri(resource);
		const rejected = assert.rejects(Promise.resolve(pending), { name: 'CancellationError' });
		generation++;
		connection.fire();
		void response.complete({ scopes: [{ path: '.', sensitivity: 'insensitive' }] });
		await rejected;
		assert.equal(identity.extUri.isEqual(resource, root.joinPathSegment('FILE')), false);
		response = new DeferredPromise();
		const prepared = identity.resolveCanonicalUri(resource);
		void response.complete({ scopes: [{ path: '.', sensitivity: 'insensitive' }] });
		await prepared;
		assert.equal(identity.extUri.isEqual(resource, root.joinPathSegment('FILE')), true);
		workspace.updateWorkspace({ id: 'replacement', uri: root });
		assert.equal(identity.extUri.isEqual(resource, root.joinPathSegment('FILE')), false);
		response = new DeferredPromise();
		const disposed = assert.rejects(Promise.resolve(identity.resolveCanonicalUri(resource)), { name: 'CancellationError' });
		provider.dispose();
		void response.complete({ scopes: [{ path: '.', sensitivity: 'insensitive' }] });
		await disposed;
	});

	test('cancelling one waiter preserves the shared query and file changes refresh its facts', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		using changes = new Emitter<FsChanged>();
		const response = new DeferredPromise<FsReadPathCaseSensitivityResult>();
		let count = 0;
		const host = createDisconnectedRendererApi();
		using provider = new AppServerFileSystemProvider({ workspaceContextService: workspace, resourceApi: host.resource, onDidChange: changes.event, api: { ...host.fs, readPathCaseSensitivity: async () => ++count === 1 ? response.p : { scopes: [{ path: '.', sensitivity: 'sensitive' }] } } });
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const resource = root.joinPathSegment('File');
		const controller = new AbortController();
		const cancelled = assert.rejects(Promise.resolve(identity.resolveCanonicalUri(resource, controller.signal)), { name: 'CancellationError' });
		const retained = identity.resolveCanonicalUri(resource);
		controller.abort();
		await cancelled;
		void response.complete({ scopes: [{ path: '.', sensitivity: 'insensitive' }] });
		await retained;
		assert.equal(count, 1);
		changes.fire({ type: 'rescanRequired', dirId: 'project' });
		assert.equal(identity.extUri.isEqual(resource, root.joinPathSegment('FILE')), true);
		await identity.resolveCanonicalUri(resource);
		assert.deepEqual([count, identity.extUri.isEqual(resource, root.joinPathSegment('FILE'))], [2, false]);
	});

	test('the production model acquisition prepares backend rules before sharing edited aliases', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		const host = createDisconnectedRendererApi();
		const reads: string[] = [];
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace,
			api: {
				...host.fs, readPathCaseSensitivity: async () => ({ scopes: [{ path: '.', sensitivity: 'insensitive' }] }),
				readBinaryFile: async params => { reads.push(params.path); return { resource: { resourceId: 'content', mimeType: 'text/plain', size: 4, sha256: 'digest' }, revision: 'revision' }; },
				getMetadata: async () => ({ fileType: 'file', sizeBytes: 4, readonly: false, modifiedAtMillis: null }),
			}, resourceApi: { ...host.resource, read: async () => ({ resourceId: 'content', offset: 0, dataBase64: 'ZGlzaw==', decodedLength: 4, eof: true }), release: async () => { } },
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		using first = await models.acquire({ resource: root.joinPathSegment('File') }, signal);
		first.model.setValue('unsaved');
		using second = await models.acquire({ resource: root.joinPathSegment('FILE') }, signal);
		assert.equal(second.model, first.model);
		assert.deepEqual([models.getModels().length, second.model.getText(), second.isDirty], [1, 'unsaved', true]);
		assert.ok(reads.every(path => path === 'File'));
	});
	test('file changes retire an earlier acquisition before it can reuse an edited alias', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		using changes = new Emitter<FsChanged>();
		const oldResponse = new DeferredPromise<FsReadPathCaseSensitivityResult>();
		let queries = 0;
		const host = createDisconnectedRendererApi();
		const reads: string[] = [];
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace,
			onDidChange: changes.event,
			api: {
				...host.fs,
				readPathCaseSensitivity: async () => ++queries === 2 ? oldResponse.p : { scopes: [{ path: '.', sensitivity: queries === 1 ? 'insensitive' : 'sensitive' }] },
				readBinaryFile: async params => { reads.push(params.path); return { resource: { resourceId: 'content', mimeType: 'text/plain', size: 4, sha256: 'digest' }, revision: 'revision' }; },
				getMetadata: async () => ({ fileType: 'file', sizeBytes: 4, readonly: false, modifiedAtMillis: null }),
			},
			resourceApi: { ...host.resource, read: async () => ({ resourceId: 'content', offset: 0, dataBase64: 'ZGlzaw==', decodedLength: 4, eof: true }), release: async () => { } },
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		const firstResource = root.joinPathSegment('File');
		const alias = root.joinPathSegment('FILE');
		using first = await models.acquire({ resource: firstResource }, signal);
		first.model.setValue('unsaved');
		const rejected = assert.rejects(models.acquire({ resource: alias }, signal), { name: 'CancellationError' });
		changes.fire({ type: 'rescanRequired', dirId: 'project' });
		await services.get(IUriIdentityService).resolveCanonicalUri(firstResource);
		void oldResponse.complete({ scopes: [{ path: '.', sensitivity: 'insensitive' }] });
		await rejected;
		using second = await models.acquire({ resource: alias }, signal);
		assert.deepEqual([first.model === second.model, first.model.getText(), second.model.getText(), reads], [false, 'unsaved', 'disk', ['File', 'FILE']]);
	});

	test('a shorter refresh removes unconfirmed descendants while preserving sibling facts', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		using changes = new Emitter<FsChanged>();
		let missing = false;
		const host = createDisconnectedRendererApi();
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace, resourceApi: host.resource, onDidChange: changes.event,
			api: { ...host.fs, readPathCaseSensitivity: async params => ({ scopes: [
				{ path: '.', sensitivity: 'sensitive' },
				...(missing && params.path.startsWith('Parent/') ? [] : [{ path: params.path.split('/')[0], sensitivity: 'insensitive' as const }]),
			] }) },
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const parentFile = URI.file('/workspace/Parent/File');
		const otherFile = URI.file('/workspace/Other/File');
		await identity.resolveCanonicalUri(parentFile);
		await identity.resolveCanonicalUri(otherFile);
		assert.equal(identity.extUri.isEqual(parentFile, URI.file('/workspace/Parent/FILE')), true);
		missing = true;
		changes.fire({ type: 'pathsChanged', dirId: 'project', paths: ['Parent'] });
		await identity.resolveCanonicalUri(parentFile);
		assert.deepEqual([
			identity.extUri.isEqual(parentFile, URI.file('/workspace/Parent/FILE')),
			identity.extUri.isEqual(otherFile, URI.file('/workspace/Other/FILE')),
		], [false, true]);
	});

	test('transient rule eviction keeps retained URI facts and releases them with their owner', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		const host = createDisconnectedRendererApi();
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace, resourceApi: host.resource,
			api: { ...host.fs, readPathCaseSensitivity: async params => ({ scopes: [{ path: '.', sensitivity: 'sensitive' }, { path: params.path.split('/')[0], sensitivity: 'insensitive' }] }) },
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const resource = URI.file('/workspace/Original/File');
		const alias = URI.file('/workspace/Original/FILE');
		using retained = identity.retainUri(resource);
		await identity.resolveCanonicalUri(resource);
		for (let index = 0; index < 4097; index++) await identity.resolveCanonicalUri(URI.file(`/workspace/other${index}/File`));
		assert.equal(identity.extUri.isEqual(resource, alias), true);
		retained.dispose();
		await identity.resolveCanonicalUri(URI.file('/workspace/last/File'));
		assert.equal(identity.extUri.isEqual(resource, alias), false);
	});

	test('discovering directory rules does not reread existing clean models', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		const host = createDisconnectedRendererApi();
		const reads: string[] = [];
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace,
			api: {
				...host.fs,
				readPathCaseSensitivity: async params => ({ scopes: [{ path: '.', sensitivity: 'sensitive' }, { path: params.path.split('/')[0], sensitivity: 'insensitive' }] }),
				readBinaryFile: async params => { reads.push(params.path); return { resource: { resourceId: 'content', mimeType: 'text/plain', size: 4, sha256: 'digest' }, revision: 'revision' }; },
				getMetadata: async () => ({ fileType: 'file', sizeBytes: 4, readonly: false, modifiedAtMillis: null }),
			},
			resourceApi: { ...host.resource, read: async () => ({ resourceId: 'content', offset: 0, dataBase64: 'ZGlzaw==', decodedLength: 4, eof: true }), release: async () => { } },
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		using textFiles = createTestTextFileService(files);
		using models = services.createInstance(BrowserTextModelService, new BrowserTextResourceStore(textFiles), {});
		const signal = new AbortController().signal;
		using first = await models.acquire({ resource: URI.file('/workspace/a/File') }, signal);
		using second = await models.acquire({ resource: URI.file('/workspace/b/File') }, signal);
		using third = await models.acquire({ resource: URI.file('/workspace/c/File') }, signal);
		first.model.setValue('unsaved');
		const identity = services.get(IUriIdentityService);
		for (let index = 0; index < 4097; index++) await identity.resolveCanonicalUri(URI.file(`/workspace/other${index}/File`));
		assert.deepEqual([models.getModels().length, reads, models.getModel(URI.file('/workspace/a/FILE')) === first.model, first.model.getText()], [3, ['a/File', 'b/File', 'c/File'], true, 'unsaved']);
	});

	test('unrelated workspace events keep another root query valid', async () => {
		const root = URI.file('/one');
		using workspace = new WorkspaceContextService({ id: 'multi', folders: [
			{ id: 'one', uri: root, name: 'one', index: 0 },
			{ id: 'two', uri: URI.file('/two'), name: 'two', index: 1 },
		] });
		using changes = new Emitter<FsChanged>();
		const response = new DeferredPromise<FsReadPathCaseSensitivityResult>();
		const host = createDisconnectedRendererApi();
		let queries = 0;
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace, resourceApi: host.resource, onDidChange: changes.event,
			api: { ...host.fs, readPathCaseSensitivity: () => { queries++; return response.p; } },
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const resource = root.joinPathSegment('File');
		const pending = identity.resolveCanonicalUri(resource);
		changes.fire({ type: 'pathsChanged', dirId: 'two', paths: ['File'] });
		void response.complete({ scopes: [{ path: '.', sensitivity: 'insensitive' }] });
		await pending;
		await identity.resolveCanonicalUri(resource);
		assert.deepEqual([queries, identity.extUri.isEqual(resource, root.joinPathSegment('FILE'))], [1, true]);
	});

	test('provider replacement rejects its predecessor query without committing canonical spelling', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		const response = new DeferredPromise<FsReadPathCaseSensitivityResult>();
		const host = createDisconnectedRendererApi();
		using predecessor = new AppServerFileSystemProvider({ workspaceContextService: workspace, resourceApi: host.resource, api: { ...host.fs, readPathCaseSensitivity: () => response.p } });
		using replacement = new AppServerFileSystemProvider({ workspaceContextService: workspace, resourceApi: host.resource, api: { ...host.fs, readPathCaseSensitivity: async () => ({ scopes: [{ path: '.', sensitivity: 'sensitive' }] }) } });
		using files = new FileService();
		using previousRegistration = files.registerProvider('file', predecessor);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const resource = root.joinPathSegment('File');
		const rejected = assert.rejects(Promise.resolve(identity.resolveCanonicalUri(resource)), { name: 'CancellationError' });
		previousRegistration.dispose();
		using currentRegistration = files.registerProvider('file', replacement);
		await identity.resolveCanonicalUri(resource);
		void response.complete({ scopes: [{ path: '.', sensitivity: 'insensitive' }] });
		await rejected;
		assert.equal(identity.extUri.isEqual(resource, root.joinPathSegment('FILE')), false);
	});

	test('invalid observation paths cannot partially change shared comparison facts', async () => {
		const root = URI.file('/workspace');
		using workspace = new WorkspaceContextService({ id: 'project', uri: root });
		const host = createDisconnectedRendererApi();
		using provider = new AppServerFileSystemProvider({
			workspaceContextService: workspace, resourceApi: host.resource,
			api: { ...host.fs, readPathCaseSensitivity: async () => ({ scopes: [
				{ path: '.', sensitivity: 'insensitive' },
				{ path: '../outside', sensitivity: 'insensitive' },
			] }) },
		});
		using files = new FileService();
		using registration = files.registerProvider('file', provider);
		using services = new TestUriIdentityServices(files);
		const identity = services.get(IUriIdentityService);
		const resource = root.joinPathSegment('File');
		await assert.rejects(Promise.resolve(identity.resolveCanonicalUri(resource)), /outside the workspace/);
		assert.equal(identity.extUri.isEqual(resource, root.joinPathSegment('FILE')), false);
	});

});
