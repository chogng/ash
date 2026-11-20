import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { autorun } from '../../../../base/common/observable.js';
import { observableConfigValue } from '../../../../platform/observable/common/platformObservableUtils.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { StorageScope, StorageTarget, type IStorageService } from '../../../../platform/storage/common/storage.js';
import type { IEditorPart } from '../../../browser/parts/editor/editorPart.js';
import type { EditorWorkingSet } from '../../../services/editor/common/editorWorkingSet.js';
import type { ISCMViewService } from '../common/scm.js';

const WorkingSetsStorageKey = 'scm.workingSets';

interface SerializedRepositoryWorkingSets {
	readonly repositoryKey: string;
	/** Persisted ref that owns the visible working set. */
	readonly currentRef: string;
	readonly editorWorkingSets: readonly (readonly [string, EditorWorkingSet])[];
}

interface RepositoryWorkingSets {
	workingSetRef: string;
	readonly editorWorkingSets: Map<string, EditorWorkingSet>;
}

export interface ScmWorkingSetControllerOptions {
	readonly configurationService: IConfigurationService;
	readonly editorPart: IEditorPart;
	readonly scmViewService: ISCMViewService;
	readonly storageService: IStorageService;
}

/** Saves and restores editor tabs when the selected repository reference changes. */
export class ScmWorkingSetController extends Disposable {
	private readonly enabledResources = this._register(new DisposableStore());
	private readonly providerListener = this._register(new MutableDisposable());
	private readonly repositoryWorkingSets = new Map<string, RepositoryWorkingSets>();
	private statusQueue = Promise.resolve();
	private lastObservedRefIdentity: string | undefined;
	private generation = 0;

	constructor(private readonly options: ScmWorkingSetControllerOptions) {
		super();
		const enabled = observableConfigValue('scm.workingSets.enabled', false, options.configurationService);
		this._register(autorun(reader => this.configure(enabled.read(reader))));
	}

	private configure(enabled: boolean): void {
		this.generation += 1;
		this.enabledResources.clear();
		this.repositoryWorkingSets.clear();
		this.lastObservedRefIdentity = undefined;
		this.providerListener.clear();
		if (!enabled) {
			this.options.storageService.remove(WorkingSetsStorageKey, StorageScope.WORKSPACE);
			return;
		}
		this.load();
		this.enabledResources.add(this.options.scmViewService.onDidChangeActiveRepository(() => this.bindProvider()));
		this.bindProvider();
	}

	private bindProvider(): void {
		const repository = this.options.scmViewService.activeRepository;
		this.providerListener.value = repository?.provider.onDidChangeResources(() => this.enqueue(repository.id, repository.provider.activeRepositoryName));
		if (repository) this.enqueue(repository.id, repository.provider.activeRepositoryName);
	}

	private enqueue(repositoryId: string, ref: string | undefined): void {
		if (ref === undefined) return;
		const identity = `${repositoryId}:${ref}`;
		if (identity === this.lastObservedRefIdentity) return;
		this.lastObservedRefIdentity = identity;
		const generation = this.generation;
		this.statusQueue = this.statusQueue.then(() => {
			if (!this.isDisposed && generation === this.generation) return this.acceptRef(repositoryId, ref);
		}).catch(() => undefined);
	}

	private async acceptRef(repositoryKey: string, ref: string): Promise<void> {
		const repository = this.repositoryWorkingSets.get(repositoryKey);
		if (!repository) {
			this.repositoryWorkingSets.set(repositoryKey, { workingSetRef: ref, editorWorkingSets: new Map() });
			return;
		}
		const previousRef = repository.workingSetRef;
		if (previousRef === ref) return;
		repository.editorWorkingSets.set(previousRef, this.options.editorPart.saveWorkingSet(previousRef));
		const workingSet = repository.editorWorkingSets.get(ref)
			?? (this.options.configurationService.getValue('scm.workingSets.default') === 'empty' ? 'empty' : undefined);
		try {
			if (workingSet) {
				await this.options.editorPart.applyWorkingSet(workingSet, { preserveFocus: !this.hasEditorFocus() });
			}
			// Closing confirmation can veto restoration while Git remains on the new ref.
			repository.workingSetRef = ref;
		} finally {
			if (!this.isDisposed && this.repositoryWorkingSets.get(repositoryKey) === repository) this.store();
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
					workingSetRef: serialized.currentRef,
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
			currentRef: state.workingSetRef,
			editorWorkingSets: [...state.editorWorkingSets],
		}));
		this.options.storageService.store(WorkingSetsStorageKey, JSON.stringify(serialized), StorageScope.WORKSPACE, StorageTarget.MACHINE);
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
