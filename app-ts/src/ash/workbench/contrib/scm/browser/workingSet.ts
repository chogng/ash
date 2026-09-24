import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { GitStatus, IGitService } from '../../../services/git/common/gitService.js';
import type { EditorWorkingSet } from '../../../services/editor/common/editorWorkingSet.js';
import { ScmConfiguration } from '../common/scmConfiguration.js';

const WorkingSetsStorageKey = 'scm.workingSets';

interface SerializedRepositoryWorkingSets {
	readonly repositoryKey: string;
	readonly currentRef: string;
	readonly editorWorkingSets: readonly (readonly [string, EditorWorkingSet])[];
}

interface RepositoryWorkingSets {
	currentRef: string;
	readonly editorWorkingSets: Map<string, EditorWorkingSet>;
}

export interface ScmWorkingSetControllerOptions {
	readonly configurationService: IConfigurationService;
	readonly editorPart: IEditorPart;
	readonly gitService: IGitService;
	readonly storageService: IStorageService;
}

/** Saves and restores editor tabs when the active Git branch changes. */
export class ScmWorkingSetController extends Disposable {
	private readonly enabledResources = this._register(new DisposableStore());
	private readonly repositoryWorkingSets = new Map<string, RepositoryWorkingSets>();
	private statusQueue = Promise.resolve();
	private lastStatusIdentity: string | undefined;
	private generation = 0;

	constructor(private readonly options: ScmWorkingSetControllerOptions) {
		super();
		this._register(options.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ScmConfiguration.workingSetsEnabled)) this.configure();
		}));
		this.configure();
	}

	private configure(): void {
		this.generation += 1;
		this.enabledResources.clear();
		this.repositoryWorkingSets.clear();
		this.lastStatusIdentity = undefined;
		if (!this.options.configurationService.getValue(ScmConfiguration.workingSetsEnabled)) {
			this.options.storageService.remove(WorkingSetsStorageKey, StorageScope.WORKSPACE);
			return;
		}
		this.load();
		this.enabledResources.add(this.options.gitService.onDidChangeStatus(status => this.enqueue(status)));
		this.enabledResources.add(this.options.gitService.onDidBecomeReady(() => this.refresh()));
		this.refresh();
	}

	private refresh(): void {
		void this.options.gitService.status().then(status => this.enqueue(status)).catch(() => undefined);
	}

	private enqueue(status: GitStatus): void {
		const identity = `${status.repositoryId}:${status.streamInstanceId}:${status.revision}`;
		if (identity === this.lastStatusIdentity) return;
		this.lastStatusIdentity = identity;
		const generation = this.generation;
		this.statusQueue = this.statusQueue.then(() => generation === this.generation ? this.acceptStatus(status) : undefined).catch(() => undefined);
	}

	private async acceptStatus(status: GitStatus): Promise<void> {
		const ref = historyRef(status);
		if (!ref) return;
		const repositoryKey = status.repositoryId;
		const repository = this.repositoryWorkingSets.get(repositoryKey);
		if (!repository) {
			this.repositoryWorkingSets.set(repositoryKey, { currentRef: ref, editorWorkingSets: new Map() });
			return;
		}
		if (repository.currentRef === ref) return;
		repository.editorWorkingSets.set(repository.currentRef, this.options.editorPart.saveWorkingSet(repository.currentRef));
		repository.currentRef = ref;
		this.store();
		const workingSet = repository.editorWorkingSets.get(ref);
		if (workingSet) {
			await this.options.editorPart.applyWorkingSet(workingSet, { preserveFocus: !this.hasEditorFocus() });
			return;
		}
		if (this.options.configurationService.getValue(ScmConfiguration.workingSetsDefault) === 'empty') {
			await this.options.editorPart.applyWorkingSet('empty', { preserveFocus: !this.hasEditorFocus() });
		}
	}

	private hasEditorFocus(): boolean {
		return this.options.editorPart.domNode.contains(this.options.editorPart.domNode.ownerDocument.activeElement);
	}

	private load(): void {
		const raw = this.options.storageService.get(WorkingSetsStorageKey, StorageScope.WORKSPACE);
		if (!raw) return;
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) throw new TypeError('SCM working sets must be an array');
			for (const entry of parsed) {
				const serialized = validateSerializedRepository(entry);
				this.repositoryWorkingSets.set(serialized.repositoryKey, {
					currentRef: serialized.currentRef,
					editorWorkingSets: new Map(serialized.editorWorkingSets),
				});
			}
		} catch {
			this.repositoryWorkingSets.clear();
			this.options.storageService.remove(WorkingSetsStorageKey, StorageScope.WORKSPACE);
		}
	}

	private store(): void {
		const serialized: SerializedRepositoryWorkingSets[] = [...this.repositoryWorkingSets].map(([repositoryKey, state]) => ({
			repositoryKey,
			currentRef: state.currentRef,
			editorWorkingSets: [...state.editorWorkingSets],
		}));
		this.options.storageService.store(WorkingSetsStorageKey, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}

function historyRef(status: GitStatus): string | undefined {
	switch (status.head.type) {
		case 'branch': return status.head.name;
		case 'detached': return status.head.objectId;
		case 'unborn': return status.head.name;
	}
}

function validateSerializedRepository(value: unknown): SerializedRepositoryWorkingSets {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Invalid SCM repository working set');
	const record = value as Record<string, unknown>;
	if (typeof record.repositoryKey !== 'string' || !record.repositoryKey || typeof record.currentRef !== 'string' || !record.currentRef || !Array.isArray(record.editorWorkingSets)) {
		throw new TypeError('Invalid SCM repository working set');
	}
	for (const entry of record.editorWorkingSets) {
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'object' || entry[1] === null) {
			throw new TypeError('Invalid SCM editor working set entry');
		}
	}
	return record as unknown as SerializedRepositoryWorkingSets;
}
