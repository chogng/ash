import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { JSDOM } from 'jsdom';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { URI } from '../../../../../base/common/uri.js';
import { IProjectService, type Project, type ProjectMaterial } from '../../../../../platform/projects/common/projectService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { type IProjectsService, ProjectsService } from '../../browser/projectsService.js';

class ProjectsFixture extends Disposable {
	public readonly services = this._register(new InstantiationService());
	public readonly changed = this._register(new Emitter<void>());
	public readonly projectsView: IProjectsService;
	public readonly storage: IStorageService;
	public projects: Project[] = [];
	public pending: DeferredPromise<readonly Project[]> | undefined;
	public failure: Error | undefined;

	constructor() {
		super();
		const browser = new JSDOM('', { url: 'https://projects.test' });
		const storage = this._register(
			new BrowserStorageService({
				ownerWindow: browser.window as unknown as Window,
				workspaceId: 'projects-test',
				flushInterval: 0,
				onError: error => {
					throw error;
				},
			}),
		);
		this.storage = storage;
		this._register(toDisposable(() => browser.window.close()));
		this.services.registerInstance(IStorageService, storage);
		this.services.registerInstance(IProjectService, {
			addSession: async () => {
				throw new Error('Unexpected project membership change');
			},
			onDidChange: this.changed.event,
			list: async () => (this.pending ? this.pending.p : [...this.projects]),
			read: async id => this.projects.find(project => project.id === id)!,
			create: async (id, name, description, materials) => {
				if (this.failure) {
					throw this.failure;
				}
				const project: Project = {
					id,
					name,
					description,
					materials,
					revision: 1,
					archived: false,
					sessionCount: 0,
					sessionIds: [],
				};
				this.projects.push(project);
				this.changed.fire();
				return project;
			},
			update: async (project, name, description, materials) => {
				if (this.failure) {
					throw this.failure;
				}
				const saved = { ...project, name, description, materials, revision: project.revision + 1 };
				this.projects = this.projects.map(value => (value.id === project.id ? saved : value));
				this.changed.fire();
				return saved;
			},
			archive: async project => {
				if (this.failure) {
					throw this.failure;
				}
				const saved = {
					...this.projects.find(value => value.id === project.id)!,
					archived: true,
					revision: project.revision + 1,
				};
				this.projects = this.projects.map(value => (value.id === project.id ? saved : value));
				this.changed.fire();
				return saved;
			},
			remove: async project => {
				if (this.failure) {
					throw this.failure;
				}
				this.projects = this.projects.filter(value => value.id !== project.id);
				this.changed.fire();
			},
		});
		this.projectsView = this._register(this.services.createInstance(ProjectsService));
	}
}

suite('Projects browsing', () => {
	test('remembers every sort order for this profile and shares the latest selection with retained views', () => {
		using fixture = new ProjectsFixture();
		using otherProfile = new ProjectsFixture();
		for (const order of ['created', 'name', 'updated'] as const) {
			fixture.projectsView.setSortOrder(order);
			assert.equal(fixture.storage.get('sessions.projects.sortOrder', StorageScope.PROFILE), order);
			using restored = fixture.services.createInstance(ProjectsService);
			assert.equal(restored.state.get().sortOrder, order);
			restored.setSortOrder('name');
			assert.equal(fixture.projectsView.state.get().sortOrder, 'name');
		}
		assert.equal(otherProfile.projectsView.state.get().sortOrder, 'updated');
		fixture.storage.remove('sessions.projects.sortOrder', StorageScope.PROFILE);
		assert.equal(fixture.projectsView.state.get().sortOrder, 'updated');
	});

	test('ignores workspace sorting and restores the default for invalid saved choices', () => {
		using fixture = new ProjectsFixture();
		fixture.projectsView.setSortOrder('created');
		fixture.storage.store('sessions.projects.sortOrder', 'name', StorageScope.WORKSPACE, StorageTarget.USER);
		assert.equal(fixture.projectsView.state.get().sortOrder, 'created');
		for (const invalid of ['reverse', '', 'null']) {
			fixture.storage.store('sessions.projects.sortOrder', invalid, StorageScope.PROFILE, StorageTarget.USER);
			using restored = fixture.services.createInstance(ProjectsService);
			assert.equal(restored.state.get().sortOrder, 'updated');
			assert.equal(fixture.projectsView.state.get().sortOrder, 'updated');
		}
	});

	test('pinning is profile state shared by retained views and sorts pinned projects first', async () => {
		using fixture = new ProjectsFixture();
		await fixture.projectsView.create('a', 'Alpha', '', []);
		await fixture.projectsView.create('z', 'Zebra', '', []);
		fixture.projectsView.togglePinned('z');
		assert.deepEqual(
			fixture.projectsView.getProjects().map(project => project.id),
			['z', 'a'],
		);
		using restored = fixture.services.createInstance(ProjectsService);
		assert.equal(restored.isPinned('z'), true);
		restored.togglePinned('z');
		assert.equal(fixture.projectsView.isPinned('z'), false);
		assert.deepEqual(
			fixture.projectsView.getProjects().map(project => project.id),
			['a', 'z'],
		);
	});

	test('archive and delete update the owning catalog and clear unavailable selection and pin state', async () => {
		using fixture = new ProjectsFixture();
		await fixture.projectsView.create('archive', 'Archive', '', []);
		assert.equal(await fixture.projectsView.archive(fixture.projects[0]), true);
		assert.equal(fixture.projectsView.state.get().selectedId, undefined);
		assert.deepEqual(fixture.projectsView.getProjects(), []);
		await fixture.projectsView.create('delete', 'Delete', '', []);
		fixture.projectsView.togglePinned('delete');
		assert.equal(await fixture.projectsView.remove(fixture.projects.find(project => project.id === 'delete')!), true);
		assert.equal(fixture.projectsView.isPinned('delete'), false);
		assert.equal(fixture.projectsView.state.get().selectedId, undefined);
		assert.deepEqual(
			fixture.projects.map(project => project.id),
			['archive'],
		);
	});

	test('creates a project containing multiple material types and restores it through its owner', async () => {
		using fixture = new ProjectsFixture();
		const materials: ProjectMaterial[] = ['paper.pdf', 'photo.png', 'budget.xlsx'].map(name => ({
			name,
			resource: URI.file(`/materials/${name}`),
			kind: 'file',
		}));
		assert.equal(await fixture.projectsView.create('research', 'Research', 'Compare the evidence', materials), true);
		assert.deepEqual(fixture.projectsView.state.get().selected?.materials, materials);
		using restored = fixture.services.createInstance(ProjectsService);
		await restored.openProject('research');
		assert.deepEqual(restored.state.get().selected, fixture.projects[0]);
		assert.match(restored.getAccessibleContent(), /paper.pdf\nphoto.png\nbudget.xlsx/);
	});

	test('ignores older reads after a creation and keeps the new project selected', async () => {
		using fixture = new ProjectsFixture();
		const previous = (fixture.pending = new DeferredPromise<readonly Project[]>());
		const reading = fixture.projectsView.reload();
		fixture.pending = undefined;
		await fixture.projectsView.create('new', 'New work', '', []);
		await previous.complete([]);
		await reading;
		assert.deepEqual(
			{
				names: fixture.projectsView.getProjects().map(project => project.name),
				selected: fixture.projectsView.state.get().selectedId,
				loading: fixture.projectsView.state.get().loading,
			},
			{ names: ['New work'], selected: 'new', loading: false },
		);
	});

	test('sorts by backend update time, creation time or name while preserving pins and search', async () => {
		using fixture = new ProjectsFixture();
		await fixture.projectsView.create('z', 'Zebra', '', []);
		await fixture.projectsView.create('a', 'Alpha', '', []);
		await fixture.projectsView.create('m', 'Middle', '', []);
		await fixture.projectsView.create('legacy', 'Legacy', '', []);
		const times = {
			z: { createdAtMs: 100, updatedAtMs: 500 },
			a: { createdAtMs: 200, updatedAtMs: 400 },
			m: { createdAtMs: 300, updatedAtMs: 300 },
		};
		fixture.projects = fixture.projects.map(project => ({
			...project,
			...times[project.id as keyof typeof times],
		}));
		await fixture.projectsView.reload();
		assert.deepEqual(
			fixture.projectsView.getProjects().map(project => project.name),
			['Zebra', 'Alpha', 'Middle', 'Legacy'],
		);
		fixture.projectsView.setSortOrder('created');
		assert.deepEqual(
			fixture.projectsView.getProjects().map(project => project.name),
			['Middle', 'Alpha', 'Zebra', 'Legacy'],
		);
		fixture.projectsView.setSortOrder('name');
		assert.deepEqual(
			fixture.projectsView.getProjects().map(project => project.name),
			['Alpha', 'Legacy', 'Middle', 'Zebra'],
		);
		fixture.projectsView.togglePinned('legacy');
		for (const order of ['updated', 'created', 'name'] as const) {
			fixture.projectsView.setSortOrder(order);
			assert.equal(fixture.projectsView.getProjects()[0].id, 'legacy');
		}
		fixture.projectsView.setQuery(' ALP ');
		assert.deepEqual(
			fixture.projectsView.getProjects().map(project => project.name),
			['Alpha'],
		);
	});

	test('failed saves preserve the backend projection and expose a retryable error', async () => {
		using fixture = new ProjectsFixture();
		await fixture.projectsView.create('research', 'Research', '', []);
		fixture.failure = new Error('Connection lost');
		assert.equal(await fixture.projectsView.update(fixture.projects[0], 'Lost edit', '', []), false);
		assert.deepEqual(
			{
				name: fixture.projectsView.state.get().selected?.name,
				busy: fixture.projectsView.state.get().busy,
				message: fixture.projectsView.state.get().message,
			},
			{ name: 'Research', busy: false, message: 'Connection lost' },
		);
	});

	test('missing project registration fails during production service construction', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(ProjectsService), /projectService/);
	});
});
