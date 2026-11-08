import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { resetNlsResolver } from '../../../../../nls.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProjectService, type Project, type ProjectMaterial } from '../../../../../platform/projects/common/projectService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { initializeTestLocalization } from '../../../../../workbench/services/localization/test/common/localizationTestUtils.js';
import { ISessionGroupsService } from '../../../../services/sessions/browser/sessionGroupsService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import '../../browser/projectsRepairActions.js';

const archivedRepair = 'projects.repairArchived';
const folderRepair = 'projects.repairCodeFolders';

function session(id: string, root = '/workspace'): ISession {
	return {
		sessionId: id, kind: 'code', title: id, status: 'active', nextApprovalMode: 'manual',
		workspace: { authorityId: 'local', root }, chats: [],
	};
}

function project(id: string, sessionIds: readonly string[], archived = false): Project {
	return {
		id, name: id, revision: 1, description: '', sessionIds, archived, createdAtMs: 1, updatedAtMs: 1, sessionCount: sessionIds.length,
		materials: [{ kind: 'folder', name: id, resource: URI.file(`/${id}`) }],
	};
}

class Fixture extends Disposable {
	readonly services = this._register(new InstantiationService());
	readonly archived: string[] = [];
	readonly created: Project[] = [];
	readonly linked: [string, string][] = [];
	sessions: ISession[] = [];
	projects: Project[] = [];
	grouped: string[] = [];
	primaryReady = true;
	deletedFolderReceipt = false;
	readonly input: TestQuickInputService;

	constructor() {
		super();
		const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://ash.test' });
		this._register(toDisposable(() => dom.window.close()));
		this.input = this._register(new TestQuickInputService({ container: dom.window.document.body, instantiationService: this.services }));
		this.services.registerInstance(IQuickInputService, this.input);
		this.services.registerInstance(INotificationService, { info() { } } as unknown as INotificationService);
		const fixture = this;
		this.services.registerInstance(ISessionsManagementService, {
			state: 'ready',
			get primaryCatalogReady() { return fixture.primaryReady; },
			get sessions() { return fixture.sessions; },
			refresh: async () => { },
			archiveSession: async (id: string) => { this.archived.push(id); },
		} as unknown as ISessionsManagementService);
		this.services.registerInstance(ISessionGroupsService, {
			get groups() { return [{ sessionIds: fixture.grouped }]; },
		} as unknown as ISessionGroupsService);
		this.services.registerInstance(IProjectService, {
			list: async () => this.projects,
			read: async (id: string) => this.projects.find(value => value.id === id)!,
			create: async (id: string, name: string, description: string, materials: readonly ProjectMaterial[], scope: string) => {
				assert.equal(scope, 'code');
				const value = { ...project(id, []), name, description, materials };
				if (this.deletedFolderReceipt && id.startsWith('folder-')) return value;
				this.created.push(value);
				this.projects.push(value);
				return value;
			},
			addSession: async (current: Project, id: string) => {
				assert.equal(this.projects.find(value => value.id === current.id), current);
				this.linked.push([current.name, id]);
				const next = { ...current, revision: current.revision + 1, sessionCount: current.sessionCount + 1, sessionIds: [...current.sessionIds, id] };
				this.projects = this.projects.map(value => value === current ? next : value);
				return next;
			},
		} as unknown as IProjectService);
	}

	async run(id: string) {
		return this.services.invokeFunction(CommandsRegistry.getCommand(id)!);
	}

	async review(id: string) {
		using subscriptions = new DisposableStore();
		const shown = new Promise<void>(resolve => subscriptions.add(Event.once(this.input.onShow)(() => resolve())));
		const completion = this.run(id);
		await Promise.race([shown, completion]);
		const picker = this.input.currentQuickInput as IQuickPick<IQuickPickItem> | undefined;
		assert.ok(picker?.canSelectMany);
		assert.deepEqual(picker.selectedItems, []);
		return { picker, completion, items: picker.items.filter((item): item is IQuickPickItem => !('type' in item)) };
	}
}

test('archived project repair previews local members and archives only the selected conversation', async () => {
	using fixture = new Fixture();
	fixture.projects = [project('archived', ['missed', 'restored', 'already-archived', 'remote'], true), project('active', ['unrelated'])];
	fixture.sessions = [
		session('missed'), session('restored'), session('unrelated'),
		{ ...session('remote'), backendSessionId: 'missed' },
		{ ...session('already-archived'), status: 'archived' },
	];
	initializeTestLocalization('zh-CN');
	using locale = toDisposable(resetNlsResolver);
	const { picker, completion, items } = await fixture.review(archivedRepair);
	assert.equal(picker.title, '选择要归档的对话');
	assert.deepEqual(items.map(item => [item.label, item.description]), [['missed', 'archived'], ['restored', 'archived']]);
	assert.deepEqual(fixture.archived, []);
	picker.selectedItems = [items[0]!];
	await picker.accept();
	await completion;
	assert.deepEqual(fixture.archived, ['missed']);
	assert.equal(fixture.projects[0]?.archived, true);
});

test('folder repair links selected conversations and creates one project per missing folder', async () => {
	using fixture = new Fixture();
	const storage = fixture.services.get(IStorageService);
	const migrationKey = 'sessions.code.folderProjectsMigrated';
	storage.store(migrationKey, true, StorageScope.PROFILE, StorageTarget.MACHINE);
	fixture.projects = [project('workspace', ['assigned']), project('archived-folder', [], true)];
	fixture.grouped = ['grouped'];
	fixture.sessions = [
		session('missed'), session('removed'), session('assigned'), session('grouped'),
		session('new-one', '/missing'), session('new-two', '/missing/'), session('archived-folder', '/archived-folder'),
		{ ...session('remote'), backendSessionId: 'missed' },
	];
	const { picker, completion, items } = await fixture.review(folderRepair);
	assert.deepEqual(items.map(item => item.label), ['missed', 'removed', 'new-one', 'new-two']);
	picker.selectedItems = items.filter(item => item.label !== 'removed');
	await picker.accept();
	await completion;
	assert.deepEqual(fixture.linked, [['workspace', 'missed'], ['missing', 'new-one'], ['missing', 'new-two']]);
	assert.equal(fixture.created.length, 1);
	assert.equal(fixture.created[0]?.materials[0]?.resource.fsPath, URI.file('/missing').fsPath);
	assert.equal(storage.getBoolean(migrationKey, StorageScope.PROFILE), true);
});

test('repair rejects an unavailable primary catalog and rechecks a restored project after preview', async () => {
	using fixture = new Fixture();
	fixture.projects = [project('archived', ['missed'], true)];
	fixture.sessions = [session('missed')];
	fixture.primaryReady = false;
	await assert.rejects(fixture.run(archivedRepair), /Could not load all local conversations/);
	fixture.primaryReady = true;
	const { picker, completion, items } = await fixture.review(archivedRepair);
	fixture.projects = [project('archived', ['missed'])];
	picker.selectedItems = items;
	await picker.accept();
	await assert.rejects(completion, /selected conversations or projects changed/);
	assert.deepEqual(fixture.archived, []);
});

test('an explicitly selected folder repair can replace a replayed deleted project', async () => {
	using fixture = new Fixture();
	fixture.sessions = [session('missed')];
	fixture.deletedFolderReceipt = true;
	const { picker, completion, items } = await fixture.review(folderRepair);
	picker.selectedItems = items;
	await picker.accept();
	await completion;
	assert.equal(fixture.created.length, 1);
	assert.ok(!fixture.created[0]?.id.startsWith('folder-'));
	assert.deepEqual(fixture.linked, [['workspace', 'missed']]);
});
