import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { IProjectService, type Project, type ProjectMaterial } from '../../../../../platform/projects/common/projectService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { type ILibraryService, LibraryService } from '../../browser/libraryService.js';

class ProjectsFixture extends Disposable {
	public readonly services = this._register(new InstantiationService());
	public readonly changed = this._register(new Emitter<void>());
	public readonly library: ILibraryService;
	public projects: Project[] = [];
	public pending: DeferredPromise<readonly Project[]> | undefined;
	public failure: Error | undefined;

	constructor() {
		super();
		this.services.registerInstance(IProjectService, {
			onDidChange: this.changed.event,
			list: async () => this.pending ? this.pending.p : [...this.projects],
			read: async id => this.projects.find(project => project.id === id)!,
			create: async (id, name, description, materials) => {
				if (this.failure) { throw this.failure; }
				const project: Project = { id, name, description, materials, revision: 1, archived: false, sessionCount: 0, sessionIds: [] };
				this.projects.push(project); this.changed.fire(); return project;
			},
			update: async (project, name, description, materials) => {
				if (this.failure) { throw this.failure; }
				const saved = { ...project, name, description, materials, revision: project.revision + 1 };
				this.projects = this.projects.map(value => value.id === project.id ? saved : value);
				this.changed.fire(); return saved;
			},
		});
		this.library = this._register(this.services.createInstance(LibraryService));
	}
}

suite('Projects browsing', () => {
	test('creates a project containing multiple material types and restores it through its owner', async () => {
		using fixture = new ProjectsFixture();
		const materials: ProjectMaterial[] = ['paper.pdf', 'photo.png', 'budget.xlsx'].map(name => ({ name, resource: URI.file(`/materials/${name}`), kind: 'file' }));
		assert.equal(await fixture.library.create('research', 'Research', 'Compare the evidence', materials), true);
		assert.deepEqual(fixture.library.state.get().selected?.materials, materials);
		using restored = fixture.services.createInstance(LibraryService);
		await restored.openProject('research');
		assert.deepEqual(restored.state.get().selected, fixture.projects[0]);
		assert.match(restored.getAccessibleContent(), /paper.pdf\nphoto.png\nbudget.xlsx/);
	});

	test('ignores older reads after a creation and keeps the new project selected', async () => {
		using fixture = new ProjectsFixture();
		const previous = fixture.pending = new DeferredPromise<readonly Project[]>();
		const reading = fixture.library.reload();
		fixture.pending = undefined;
		await fixture.library.create('new', 'New work', '', []);
		await previous.complete([]);
		await reading;
		assert.deepEqual({ names: fixture.library.getProjects().map(project => project.name), selected: fixture.library.state.get().selectedId, loading: fixture.library.state.get().loading }, { names: ['New work'], selected: 'new', loading: false });
	});

	test('search and sort affect project cards without exposing material categories', async () => {
		using fixture = new ProjectsFixture();
		await fixture.library.create('z', 'Zebra', '', []);
		await fixture.library.create('a', 'Alpha', '', []);
		assert.deepEqual(fixture.library.getProjects().map(project => project.name), ['Alpha', 'Zebra']);
		fixture.library.toggleSort();
		assert.deepEqual(fixture.library.getProjects().map(project => project.name), ['Zebra', 'Alpha']);
		fixture.library.setQuery(' ALP ');
		assert.deepEqual(fixture.library.getProjects().map(project => project.name), ['Alpha']);
	});

	test('failed saves preserve the backend projection and expose a retryable error', async () => {
		using fixture = new ProjectsFixture();
		await fixture.library.create('research', 'Research', '', []);
		fixture.failure = new Error('Connection lost');
		assert.equal(await fixture.library.update(fixture.projects[0], 'Lost edit', '', []), false);
		assert.deepEqual({ name: fixture.library.state.get().selected?.name, busy: fixture.library.state.get().busy, message: fixture.library.state.get().message }, { name: 'Research', busy: false, message: 'Connection lost' });
	});

	test('missing project registration fails during production service construction', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(LibraryService), /projectService/);
	});
});
