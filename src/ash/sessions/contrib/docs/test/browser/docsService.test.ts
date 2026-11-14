import { observableValue } from '../../../../../base/common/observable.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { Schemas } from '../../../../../base/common/network.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IAgentConnection } from '../../../../../platform/agentHost/common/agentService.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import type { ArtifactResource, ArtifactSource, IArtifactCatalog } from '../../../../../platform/artifactCatalog/common/artifactCatalog.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { InstantiationType } from '../../../../../platform/instantiation/common/extensions.js';
import { IUserDataProfileService } from '../../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../../workbench/services/userDataProfile/browser/userDataProfileService.js';
import { ArtifactCatalogService } from '../../../../services/artifactCatalog/browser/artifactCatalogService.js';
import { IArtifactCatalogService } from '../../../../services/artifactCatalog/common/artifactCatalogService.js';
import { DocsService } from '../../browser/docsService.js';
import { IDocsService } from '../../common/docsService.js';

const source: ArtifactSource = { providerId: 'ash', accountId: null, sessionId: 'session', threadId: 'thread', itemId: 'reply', partId: 'markdown' };

for (const missing of [IArtifactCatalogService, IFileService, IUserDataProfileService, ILogService]) {
	test(`Docs construction requires ${missing.toString()}`, () => {
		using fixture = new Fixture();
		using scope = new InstantiationService();
		const catalog = fixture.createCatalog();
		if (missing !== IArtifactCatalogService) scope.registerInstance(IArtifactCatalogService, catalog);
		if (missing !== IFileService) scope.registerInstance(IFileService, fixture.files);
		if (missing !== IUserDataProfileService) scope.registerInstance(IUserDataProfileService, fixture.services.get(IUserDataProfileService));
		if (missing !== ILogService) scope.registerInstance(ILogService, fixture.services.get(ILogService));
		assert.throws(() => scope.createInstance(DocsService), new RegExp(`Unknown service: ${missing.toString()}`, 'u'));
	});
}

class Fixture extends Disposable {
	readonly files = this._register(new FileService());
	readonly entries = new Map<string, ArtifactResource>();
	readonly scopes: string[] = [];
	registrations = 0;
	offline = false;
	readonly catalog: IArtifactCatalog = {
		onDidChange: Event.None,
		list: async (clientId, accountIds) => { this.scopes.push(clientId); return [...this.entries.values()].filter(file => file.source.accountId === null || accountIds.includes(file.source.accountId)); },
		register: async (clientId, file) => {
			this.registrations++;
			if (this.offline) throw new Error('Connection closed');
			this.scopes.push(clientId);
			const existing = this.entries.get(file.id);
			const entry = existing ?? { ...file, createdAt: Date.now() };
			this.entries.set(file.id, entry);
			return entry;
		},
	};
	readonly services = this._register(new InstantiationService());

	constructor() {
		super();
		const provider = this._register(new InMemoryFileSystemProvider());
		this._register(this.files.registerProvider(Schemas.vscodeUserData, provider));
		this.services.registerInstance(IAgentConnection, { artifactCatalog: this.catalog } as IAgentConnection);
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IUserDataProfileService, new UserDataProfileService());
		this.services.registerInstance(ILogService, this._register(new NullLoggerService()));
	}

	create(): { docs: DocsService; catalog: ArtifactCatalogService; dispose(): void; } {
		const scope = this._register(this.services.createChild());
		const catalog = this._register(scope.createInstance(ArtifactCatalogService));
		scope.registerInstance(IArtifactCatalogService, catalog);
		const docs = this._register(scope.createInstance(DocsService));
		return { docs, catalog, dispose: () => { docs.dispose(); catalog.dispose(); } };
	}

	createCatalog(): ArtifactCatalogService {
		return this._register(this.services.createInstance(ArtifactCatalogService));
	}
}

test('delayed Docs construction allows catalog observers to read document recovery state', async () => {
	using fixture = new Fixture();
	using scope = fixture.services.createChild();
	scope.registerSingleton(IArtifactCatalogService, () => scope.createInstance(ArtifactCatalogService), { instantiation: InstantiationType.Delayed });
	scope.registerSingleton(IDocsService, () => scope.createInstance(DocsService), { instantiation: InstantiationType.Delayed });
	const catalog = scope.get(IArtifactCatalogService);
	const docs = scope.get(IDocsService);
	await catalog.refresh();
	const errors: unknown[] = [];
	using listener = catalog.onDidChange(() => {
		try { void docs.error; } catch (error) { errors.push(error); }
	});
	assert.equal(docs.error, undefined);
	await docs.recoverImports();
	assert.deepEqual(errors, []);
});

test('artifact catalog metadata reads and registrations never materialize document files', async () => {
	using fixture = new Fixture();
	const catalog = fixture.createCatalog();
	await catalog.refresh();
	const resource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/chart.svg' });
	const registered = await catalog.register({ id: 'a'.repeat(64), resource, title: 'Chart', contentType: 'image/svg+xml', source: { ...source, partId: 'svg' } });
	await catalog.refresh();
	assert.deepEqual(catalog.files, [registered]);
	await assert.rejects(fixture.files.stat(resource));
	await assert.rejects(fixture.files.stat(URI.from({ scheme: Schemas.vscodeUserData, path: '/user/documents/pending' })));
});

test('generated Markdown is a real file and replay after restart preserves user edits', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.docs.recoverImports();
	const published = await service.docs.importMarkdown(source, '# Launch plan\n\nOriginal text');
	assert.equal(published.title, 'Launch plan');
	assert.equal(published.contentType, 'text/markdown');
	const saved = await fixture.files.readFile(published.resource);
	assert.equal(saved.content, '# Launch plan\n\nOriginal text');
	await fixture.files.writeFile({ resource: published.resource, content: '# Edited plan', expectedRevision: saved.revision });
	service.dispose();
	const restarted = fixture.create();
	await restarted.docs.recoverImports();
	const replayed = await restarted.docs.importMarkdown(source, '# Original output repeated');
	assert.equal(replayed.id, published.id);
	assert.equal(replayed.resource.toString(), published.resource.toString());
	assert.equal((await fixture.files.readFile(replayed.resource)).content, '# Edited plan');
	assert.equal(fixture.registrations, 1);
	assert.equal(new Set(fixture.scopes).size, 1);
});

test('failed registration is retried from durable receipts without Chat replay', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.docs.recoverImports();
	fixture.offline = true;
	await assert.rejects(service.docs.importMarkdown(source, '# Saved before disconnect'), /Connection closed/u);
	const home = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/documents' });
	const document = (await fixture.files.readDirectory(home)).find(entry => entry.name.endsWith('.md'))!;
	assert.ok(document);
	assert.equal((await fixture.files.readFile(document.resource)).content, '# Saved before disconnect');
	service.dispose();
	fixture.offline = false;
	const restarted = fixture.create();
	await restarted.docs.recoverImports();
	assert.equal(restarted.catalog.files.length, 1);
	assert.equal(restarted.catalog.files[0].resource.toString(), document.resource.toString());
	assert.deepEqual(await fixture.files.readDirectory(URI.joinPath(home, 'imports')), []);
});

test('concurrent imports share one publication and different account outputs stay separate', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.docs.recoverImports();
	const account = observableValue<string | undefined>('account', 'other-account');
	using tracked = service.catalog.trackAccount(account);
	const first = service.docs.importMarkdown(source, '# First');
	const duplicate = service.docs.importMarkdown(source, '# Duplicate');
	assert.equal(duplicate, first);
	const [file, other] = await Promise.all([first, service.docs.importMarkdown({ ...source, accountId: 'other-account' }, '# Other')]);
	assert.notEqual(file.id, other.id);
	assert.notEqual(file.resource.toString(), other.resource.toString());
	assert.equal((await fixture.files.readFile(file.resource)).content, '# First');
	assert.equal(service.catalog.files.length, 2);
	account.set('new-account', undefined);
	assert.deepEqual(service.catalog.files.map(entry => entry.id), [file.id]);
	assert.equal(service.catalog.hasResource(other.resource), false);
	assert.equal(service.docs.isProfileDocumentPath(other.resource), true);
	await service.docs.recoverImports();
	assert.deepEqual(service.catalog.files.map(entry => entry.id), [file.id]);
	account.set('other-account', undefined);
	await service.docs.recoverImports();
	assert.equal(service.catalog.findBySource(other.source)?.id, other.id);
});

test('a damaged receipt does not hide registered files or block valid recovery', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.docs.recoverImports();
	const existing = await service.docs.importMarkdown(source, '# Registered');
	fixture.offline = true;
	await assert.rejects(service.docs.importMarkdown({ ...source, itemId: 'pending' }, '# Pending'), /Connection closed/u);
	const pendingHome = URI.joinPath(existing.resource, '..', 'imports');
	await fixture.files.writeFile({ resource: URI.joinPath(pendingHome, `${'0'.repeat(64)}.json`), content: '{broken' });
	service.dispose();
	const restarted = fixture.create();
	await restarted.docs.recoverImports();
	assert.deepEqual(restarted.catalog.files.map(file => file.id), [existing.id]);
	assert.ok(restarted.docs.error);
	fixture.offline = false;
	await restarted.docs.recoverImports();
	assert.equal(restarted.catalog.files.length, 2);
	assert.deepEqual((await fixture.files.readDirectory(pendingHome)).map(entry => entry.name), [`${'0'.repeat(64)}.json`]);
});

test('publication before catalogue reload never overwrites a previously imported file', async () => {
	using fixture = new Fixture();
	const first = fixture.create();
	await first.docs.recoverImports();
	const file = await first.docs.importMarkdown(source, '# Initial');
	await fixture.files.writeFile({ resource: file.resource, content: '# User changes' });
	const second = fixture.create();
	await second.docs.importMarkdown(source, '# Historical original');
	assert.equal((await fixture.files.readFile(file.resource)).content, '# User changes');
	assert.equal(fixture.entries.size, 1);
});


test('a crash after staging but before writing Markdown recovers without reopening Chat', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.docs.recoverImports();
	const write = fixture.files.writeFile.bind(fixture.files);
	fixture.files.writeFile = async (request, ...args) => {
		if (request.resource.path.endsWith('.md')) throw new Error('Interrupted before the document write');
		return write(request, ...args);
	};
	await assert.rejects(service.docs.importMarkdown(source, '# Recover staged body'), /Interrupted/);
	assert.equal(service.catalog.files.length, 0);
	service.dispose();
	fixture.files.writeFile = write;
	const reopened = fixture.create();
	await reopened.docs.recoverImports();
	assert.equal(reopened.catalog.files.length, 1);
	assert.equal((await fixture.files.readFile(reopened.catalog.files[0].resource)).content, '# Recover staged body');
});
