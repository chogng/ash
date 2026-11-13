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
import type { GeneratedFile, GeneratedFileSource, IGeneratedFileCatalog } from '../../../../../platform/generatedFiles/common/generatedFiles.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IUserDataProfileService } from '../../../../../workbench/services/userDataProfile/common/userDataProfile.js';
import { UserDataProfileService } from '../../../../../workbench/services/userDataProfile/browser/userDataProfileService.js';
import { GeneratedFilesService } from '../../browser/generatedFilesService.js';

const source: GeneratedFileSource = { providerId: 'ash', accountId: null, sessionId: 'session', threadId: 'thread', itemId: 'reply', partId: 'markdown' };

class Fixture extends Disposable {
	readonly files = this._register(new FileService());
	readonly entries = new Map<string, GeneratedFile>();
	readonly scopes: string[] = [];
	registrations = 0;
	offline = false;
	readonly catalog: IGeneratedFileCatalog = {
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
		this.services.registerInstance(IAgentConnection, { generatedFiles: this.catalog } as IAgentConnection);
		this.services.registerInstance(IFileService, this.files);
		this.services.registerInstance(IUserDataProfileService, new UserDataProfileService());
		this.services.registerInstance(ILogService, this._register(new NullLoggerService()));
	}

	create(): GeneratedFilesService { return this._register(this.services.createInstance(GeneratedFilesService)); }
}

test('generated Markdown is a real file and replay after restart preserves user edits', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.refresh();
	const published = await service.publishMarkdown(source, '# Launch plan\n\nOriginal text');
	assert.equal(published.title, 'Launch plan');
	assert.equal(published.contentType, 'text/markdown');
	const saved = await fixture.files.readFile(published.resource);
	assert.equal(saved.content, '# Launch plan\n\nOriginal text');
	await fixture.files.writeFile({ resource: published.resource, content: '# Edited plan', expectedRevision: saved.revision });
	service.dispose();
	const restarted = fixture.create();
	await restarted.refresh();
	const replayed = await restarted.publishMarkdown(source, '# Original output repeated');
	assert.equal(replayed.id, published.id);
	assert.equal(replayed.resource.toString(), published.resource.toString());
	assert.equal((await fixture.files.readFile(replayed.resource)).content, '# Edited plan');
	assert.equal(fixture.registrations, 1);
	assert.equal(new Set(fixture.scopes).size, 1);
});

test('failed registration is retried from durable receipts without Chat replay', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.refresh();
	fixture.offline = true;
	await assert.rejects(service.publishMarkdown(source, '# Saved before disconnect'), /Connection closed/u);
	const home = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/generated-files' });
	const document = (await fixture.files.readDirectory(home)).find(entry => entry.name.endsWith('.md'))!;
	assert.ok(document);
	assert.equal((await fixture.files.readFile(document.resource)).content, '# Saved before disconnect');
	service.dispose();
	fixture.offline = false;
	const restarted = fixture.create();
	await restarted.refresh();
	assert.equal(restarted.files.length, 1);
	assert.equal(restarted.files[0].resource.toString(), document.resource.toString());
	assert.deepEqual(await fixture.files.readDirectory(URI.joinPath(home, 'pending')), []);
});

test('concurrent imports share one publication and different account outputs stay separate', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.refresh();
	const account = observableValue<string | undefined>('account', 'other-account');
	using tracked = service.trackAccount(account);
	const first = service.publishMarkdown(source, '# First');
	const duplicate = service.publishMarkdown(source, '# Duplicate');
	assert.equal(duplicate, first);
	const [file, other] = await Promise.all([first, service.publishMarkdown({ ...source, accountId: 'other-account' }, '# Other')]);
	assert.notEqual(file.id, other.id);
	assert.notEqual(file.resource.toString(), other.resource.toString());
	assert.equal((await fixture.files.readFile(file.resource)).content, '# First');
	assert.equal(service.files.length, 2);
	account.set('new-account', undefined);
	assert.deepEqual(service.files.map(entry => entry.id), [file.id]);
	assert.equal(service.isGeneratedResource(other.resource), false);
	assert.equal(service.isProfileGeneratedPath(other.resource), true);
	await service.refresh();
	assert.deepEqual(service.files.map(entry => entry.id), [file.id]);
	account.set('other-account', undefined);
	await service.refresh();
	assert.equal(service.findBySource(other.source)?.id, other.id);
});

test('a damaged receipt does not hide registered files or block valid recovery', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.refresh();
	const existing = await service.publishMarkdown(source, '# Registered');
	fixture.offline = true;
	await assert.rejects(service.publishMarkdown({ ...source, itemId: 'pending' }, '# Pending'), /Connection closed/u);
	const pendingHome = URI.joinPath(existing.resource, '..', 'pending');
	await fixture.files.writeFile({ resource: URI.joinPath(pendingHome, `${'0'.repeat(64)}.json`), content: '{broken' });
	service.dispose();
	const restarted = fixture.create();
	await restarted.refresh();
	assert.deepEqual(restarted.files.map(file => file.id), [existing.id]);
	assert.ok(restarted.error);
	fixture.offline = false;
	await restarted.refresh();
	assert.equal(restarted.files.length, 2);
	assert.deepEqual((await fixture.files.readDirectory(pendingHome)).map(entry => entry.name), [`${'0'.repeat(64)}.json`]);
});

test('publication before catalogue reload never overwrites a previously imported file', async () => {
	using fixture = new Fixture();
	const first = fixture.create();
	await first.refresh();
	const file = await first.publishMarkdown(source, '# Initial');
	await fixture.files.writeFile({ resource: file.resource, content: '# User changes' });
	const second = fixture.create();
	await second.publishMarkdown(source, '# Historical original');
	assert.equal((await fixture.files.readFile(file.resource)).content, '# User changes');
	assert.equal(fixture.entries.size, 1);
});


test('a crash after staging but before writing Markdown recovers without reopening Chat', async () => {
	using fixture = new Fixture();
	const service = fixture.create();
	await service.refresh();
	const write = fixture.files.writeFile.bind(fixture.files);
	fixture.files.writeFile = async (request, ...args) => {
		if (request.resource.path.endsWith('.md')) throw new Error('Interrupted before the document write');
		return write(request, ...args);
	};
	await assert.rejects(service.publishMarkdown(source, '# Recover staged body'), /Interrupted/);
	assert.equal(service.files.length, 0);
	service.dispose();
	fixture.files.writeFile = write;
	const reopened = fixture.create();
	await reopened.refresh();
	assert.equal(reopened.files.length, 1);
	assert.equal((await fixture.files.readFile(reopened.files[0].resource)).content, '# Recover staged body');
});
