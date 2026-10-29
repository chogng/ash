import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import {
	IProjectService,
	type Project,
	type ProjectMaterial,
	type ProjectSummary,
} from '../../../../platform/projects/common/projectService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

export type ProjectSortOrder = 'updated' | 'created' | 'name';

const sortOrderStorageKey = 'sessions.projects.sortOrder';

export interface ProjectsState {
	readonly projects: readonly ProjectSummary[];
	readonly selectedId: string | undefined;
	readonly selected: Project | undefined;
	readonly query: string;
	readonly sortOrder: ProjectSortOrder;
	readonly loading: boolean;
	readonly busy: boolean;
	readonly message: string | undefined;
}

/** Page navigation and profile view state; IProjectService owns the durable project catalog. */
export interface IProjectsService {
	readonly state: IObservable<ProjectsState>;
	setQuery(query: string): void;
	setSortOrder(sortOrder: ProjectSortOrder): void;
	openProject(id: string): Promise<void>;
	showProjects(): void;
	reload(): Promise<void>;
	create(id: string, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<boolean>;
	update(
		project: Project,
		name: string,
		description: string,
		materials: readonly ProjectMaterial[],
	): Promise<boolean>;
	readProject(id: string): Promise<Project | undefined>;
	archive(project: ProjectSummary): Promise<boolean>;
	remove(project: ProjectSummary): Promise<boolean>;
	isPinned(id: string): boolean;
	togglePinned(id: string): void;
	getProjects(): readonly ProjectSummary[];
	getAccessibleContent(): string;
}

export const IProjectsService = createServiceIdentifier<IProjectsService>('projectsService');

export class ProjectsService extends Disposable implements IProjectsService {
	private readonly browsing = observableValue<ProjectsState>(this, {
		projects: [],
		selectedId: undefined,
		selected: undefined,
		query: '',
		sortOrder: 'updated',
		loading: false,
		busy: false,
		message: undefined,
	});
	public readonly state: IObservable<ProjectsState> = this.browsing;
	private loadSequence = 0;
	private reloadRequested = false;

	constructor(
		@IProjectService private readonly projects: IProjectService,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.patch({ sortOrder: this.readSortOrder() });
		this._register(
			storage.onDidChangeValue(event => {
				if (event.scope !== StorageScope.PROFILE) {
					return;
				}
				if (event.key === sortOrderStorageKey) {
					this.patch({ sortOrder: this.readSortOrder() });
				} else if (event.key.startsWith('sessions.projects.pinned.')) {
					this.patch({});
				}
			}),
		);
		this._register(
			projects.onDidChange(() => {
				if (this.state.get().busy) {
					this.reloadRequested = true;
				} else {
					void this.reload();
				}
			}),
		);
	}

	private patch(change: Partial<ProjectsState>): void {
		this.browsing.set({ ...this.state.get(), ...change });
	}
	private readSortOrder(): ProjectSortOrder {
		const stored = this.storage.get(sortOrderStorageKey, StorageScope.PROFILE);
		return stored === 'created' || stored === 'name' ? stored : 'updated';
	}
	public setQuery(query: string): void {
		this.patch({ query });
	}
	public setSortOrder(sortOrder: ProjectSortOrder): void {
		this.storage.store(sortOrderStorageKey, sortOrder, StorageScope.PROFILE, StorageTarget.USER);
	}
	public isPinned(id: string): boolean {
		return this.storage.getBoolean(`sessions.projects.pinned.${id}`, StorageScope.PROFILE, false);
	}
	public togglePinned(id: string): void {
		this.storage.store(
			`sessions.projects.pinned.${id}`,
			!this.isPinned(id),
			StorageScope.PROFILE,
			StorageTarget.USER,
		);
	}
	public showProjects(): void {
		this.loadSequence++;
		this.patch({ selectedId: undefined, selected: undefined, loading: false, message: undefined });
		void this.reload();
	}

	public async openProject(id: string): Promise<void> {
		this.patch({ selectedId: id, selected: undefined, message: undefined });
		await this.reload();
	}

	public async reload(): Promise<void> {
		const sequence = ++this.loadSequence;
		const selectedId = this.state.get().selectedId;
		this.patch({ loading: true, message: undefined });
		try {
			const projects = await this.projects.list();
			if (this.isDisposed || sequence !== this.loadSequence) {
				return;
			}
			const selected =
				selectedId && projects.some(project => project.id === selectedId && !project.archived)
					? await this.projects.read(selectedId)
					: undefined;
			if (this.isDisposed || sequence !== this.loadSequence) {
				return;
			}
			this.patch({ projects, selected, selectedId: selected ? selectedId : undefined, loading: false });
		} catch (error) {
			if (!this.isDisposed && sequence === this.loadSequence) {
				this.patch({
					loading: false,
					message:
						error instanceof Error
							? error.message
							: localize('projects.loadFailed', 'Could not load projects. Try again.'),
				});
			}
		}
	}

	public create(
		id: string,
		name: string,
		description: string,
		materials: readonly ProjectMaterial[],
	): Promise<boolean> {
		return this.mutate(() => this.projects.create(id, name, description, materials), true);
	}
	public update(
		project: Project,
		name: string,
		description: string,
		materials: readonly ProjectMaterial[],
	): Promise<boolean> {
		return this.mutate(() => this.projects.update(project, name, description, materials));
	}
	public async readProject(id: string): Promise<Project | undefined> {
		try {
			return await this.projects.read(id);
		} catch (error) {
			if (!this.isDisposed) {
				this.patch({
					message:
						error instanceof Error
							? error.message
							: localize('projects.loadFailed', 'Could not load projects. Try again.'),
				});
			}
			return undefined;
		}
	}
	public archive(project: ProjectSummary): Promise<boolean> {
		return this.mutate(() => this.projects.archive(project));
	}
	public async remove(project: ProjectSummary): Promise<boolean> {
		const removed = await this.mutate(() => this.projects.remove(project), false, project.id);
		if (removed) {
			this.storage.remove(`sessions.projects.pinned.${project.id}`, StorageScope.PROFILE);
		}
		return removed;
	}

	private async mutate(operation: () => Promise<Project | void>, open = false, removedId?: string): Promise<boolean> {
		if (this.state.get().busy) {
			return false;
		}
		this.loadSequence++;
		this.patch({ busy: true, message: undefined });
		try {
			const project = await operation();
			if (this.isDisposed) {
				return false;
			}
			const state = this.state.get();
			if (project) {
				this.patch({
					projects: [...state.projects.filter(item => item.id !== project.id), project],
					...(open || state.selectedId === project.id
						? {
								selectedId: project.archived ? undefined : project.id,
								selected: project.archived ? undefined : project,
							}
						: {}),
					loading: false,
				});
			} else {
				this.patch({
					projects: state.projects.filter(item => item.id !== removedId),
					...(state.selectedId === removedId ? { selectedId: undefined, selected: undefined } : {}),
					loading: false,
				});
			}
			return true;
		} catch (error) {
			if (!this.isDisposed) {
				this.reloadRequested = false;
				await this.reload();
				this.patch({
					message:
						error instanceof Error
							? error.message
							: localize('projects.saveFailed', 'Could not save the project. Try again.'),
				});
			}
			return false;
		} finally {
			if (!this.isDisposed) {
				this.patch({ busy: false });
				// Notifications received during a write may include changes from another window.
				if (this.reloadRequested) {
					this.reloadRequested = false;
					await this.reload();
				}
			}
		}
	}

	public getProjects(): readonly ProjectSummary[] {
		const state = this.state.get();
		const query = state.query.trim().toLocaleLowerCase();
		return state.projects
			.filter(project => !project.archived && project.name.toLocaleLowerCase().includes(query))
			.sort((a, b) => {
				const pinned = Number(this.isPinned(b.id)) - Number(this.isPinned(a.id));
				const time =
					state.sortOrder === 'updated'
						? (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0)
						: state.sortOrder === 'created'
							? (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0)
							: 0;
				return pinned || time || a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
			});
	}

	public getAccessibleContent(): string {
		const state = this.state.get();
		return state.selected
			? [
					state.selected.name,
					state.selected.description,
					...state.selected.materials.map(material => material.name),
					state.message,
				]
					.filter(Boolean)
					.join('\n')
			: [
					localize('projects.title', 'Projects'),
					...this.getProjects().map(project => project.name),
					state.message,
				]
					.filter(Boolean)
					.join('\n');
	}
}
