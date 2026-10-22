import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IObservable } from '../../../../base/common/observable.js';
import { localize } from '../../../../nls.js';
import { IProjectService, type Project, type ProjectMaterial, type ProjectSummary } from '../../../../platform/projects/common/projectService.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

export interface LibraryState {
	readonly projects: readonly ProjectSummary[];
	readonly selectedId: string | undefined;
	readonly selected: Project | undefined;
	readonly query: string;
	readonly descending: boolean;
	readonly loading: boolean;
	readonly busy: boolean;
	readonly message: string | undefined;
}

/** Window-local navigation only; IProjectService owns access to the durable project catalog. */
export interface ILibraryService {
	readonly state: IObservable<LibraryState>;
	setQuery(query: string): void;
	toggleSort(): void;
	openProject(id: string): Promise<void>;
	showProjects(): void;
	reload(): Promise<void>;
	create(id: string, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<boolean>;
	update(project: Project, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<boolean>;
	getProjects(): readonly ProjectSummary[];
	getAccessibleContent(): string;
}

export const ILibraryService = createServiceIdentifier<ILibraryService>('libraryService');

export class LibraryService extends Disposable implements ILibraryService {
	private readonly browsing = observableValue<LibraryState>(this, { projects: [], selectedId: undefined, selected: undefined, query: '', descending: false, loading: false, busy: false, message: undefined });
	public readonly state: IObservable<LibraryState> = this.browsing;
	private loadSequence = 0;
	private reloadRequested = false;

	constructor(@IProjectService private readonly projects: IProjectService) {
		super();
		this._register(projects.onDidChange(() => {
			if (this.state.get().busy) { this.reloadRequested = true; }
			else { void this.reload(); }
		}));
	}

	private patch(change: Partial<LibraryState>): void { this.browsing.set({ ...this.state.get(), ...change }); }
	public setQuery(query: string): void { this.patch({ query }); }
	public toggleSort(): void { this.patch({ descending: !this.state.get().descending }); }
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
			const [projects, selected] = await Promise.all([this.projects.list(), selectedId ? this.projects.read(selectedId) : undefined]);
			if (this.isDisposed || sequence !== this.loadSequence) { return; }
			this.patch({ projects, selected, loading: false });
		} catch (error) {
			if (!this.isDisposed && sequence === this.loadSequence) {
				this.patch({ loading: false, message: error instanceof Error ? error.message : localize('projects.loadFailed', 'Could not load projects. Try again.') });
			}
		}
	}

	public create(id: string, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<boolean> {
		return this.mutate(() => this.projects.create(id, name, description, materials), true);
	}
	public update(project: Project, name: string, description: string, materials: readonly ProjectMaterial[]): Promise<boolean> {
		return this.mutate(() => this.projects.update(project, name, description, materials));
	}

	private async mutate(operation: () => Promise<Project>, open = false): Promise<boolean> {
		if (this.state.get().busy) { return false; }
		this.loadSequence++;
		this.patch({ busy: true, message: undefined });
		try {
			const project = await operation();
			if (this.isDisposed) { return false; }
			const state = this.state.get();
			this.patch({
				projects: [...state.projects.filter(item => item.id !== project.id), project],
				...(open || state.selectedId === project.id ? { selectedId: project.id, selected: project } : {}),
				loading: false,
			});
			return true;
		} catch (error) {
			if (!this.isDisposed) {
				this.reloadRequested = false;
				await this.reload();
				this.patch({ message: error instanceof Error ? error.message : localize('projects.saveFailed', 'Could not save the project. Try again.') });
			}
			return false;
		} finally {
			if (!this.isDisposed) {
				this.patch({ busy: false });
				// Notifications received during a write may include changes from another window.
				if (this.reloadRequested) { this.reloadRequested = false; await this.reload(); }
			}
		}
	}

	public getProjects(): readonly ProjectSummary[] {
		const state = this.state.get();
		const query = state.query.trim().toLocaleLowerCase();
		return state.projects.filter(project => !project.archived && project.name.toLocaleLowerCase().includes(query))
			.sort((a, b) => a.name.localeCompare(b.name) * (state.descending ? -1 : 1));
	}

	public getAccessibleContent(): string {
		const state = this.state.get();
		return state.selected
			? [state.selected.name, state.selected.description, ...state.selected.materials.map(material => material.name), state.message].filter(Boolean).join('\n')
			: [localize('projects.title', 'Projects'), ...this.getProjects().map(project => project.name), state.message].filter(Boolean).join('\n');
	}
}
