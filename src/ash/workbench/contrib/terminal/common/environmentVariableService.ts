import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IMergedEnvironmentVariableCollection } from '../../../../platform/terminal/common/environmentVariable.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentVariableService, type IEnvironmentVariableCollectionWithPersistence } from './environmentVariable.js';
import { MergedEnvironmentVariableCollection } from '../../../../platform/terminal/common/environmentVariableCollection.js';
import { deserializeEnvironmentDescriptionMap, deserializeEnvironmentVariableCollection, serializeEnvironmentDescriptionMap, serializeEnvironmentVariableCollection } from '../../../../platform/terminal/common/environmentVariableShared.js';

const storageKey = 'terminal.integrated.environmentVariableCollections.v1';

/** A synchronized snapshot, never a competing extension or process environment owner. */
export class EnvironmentVariableService extends Disposable implements IEnvironmentVariableService {
	private readonly values = new Map<string, IEnvironmentVariableCollectionWithPersistence>();
	private readonly providers = new Map<string, Set<() => Promise<IEnvironmentVariableCollectionWithPersistence>>>();
	private generation = 0;
	private readonly changed = this._register(new Emitter<IMergedEnvironmentVariableCollection>());
	readonly onDidChangeCollections = this.changed.event;
	get collections(): ReadonlyMap<string, IEnvironmentVariableCollectionWithPersistence> { return this.values; }
	get mergedCollection(): IMergedEnvironmentVariableCollection {
		return new MergedEnvironmentVariableCollection(this.values);
	}

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
	) {
		super();
		this.restore();
		this._register(workspace.onDidChangeWorkspace(() => {
			this.generation++;
			this.values.clear();
			this.restore();
			this.changed.fire(this.mergedCollection);
		}));
	}

	set(extensionIdentifier: string, collection: IEnvironmentVariableCollectionWithPersistence): void {
		const previous = this.mergedCollection;
		const old = this.values.get(extensionIdentifier);
		const snapshot = new MergedEnvironmentVariableCollection(new Map([[extensionIdentifier, collection]])).collections.get(extensionIdentifier)!;
		const next = { ...snapshot, persistent: collection.persistent };
		this.values.set(extensionIdentifier, next);
		const merged = this.mergedCollection;
		const scopes = [undefined, ...[old, next].flatMap(collection => [...collection?.map.values() ?? [], ...collection?.descriptionMap?.values() ?? []].map(entry => entry.scope))];
		const variablesChanged = scopes.some(scope => previous.diff(merged, scope));
		const descriptionsChanged = JSON.stringify([...old?.descriptionMap ?? []]) !== JSON.stringify([...next.descriptionMap ?? []]);
		if (!variablesChanged && !descriptionsChanged && old?.persistent === next.persistent) return;
		this.publish();
	}

	delete(extensionIdentifier: string): void {
		if (this.values.delete(extensionIdentifier)) this.publish();
	}

	registerCollectionProvider(extensionIdentifier: string, read: () => Promise<IEnvironmentVariableCollectionWithPersistence>): IDisposable {
		let providers = this.providers.get(extensionIdentifier);
		if (!providers) this.providers.set(extensionIdentifier, providers = new Set());
		providers.add(read);
		return toDisposable(() => {
			providers.delete(read);
			if (providers.size || this.providers.get(extensionIdentifier) !== providers) return;
			this.providers.delete(extensionIdentifier);
			this.delete(extensionIdentifier);
		});
	}

	async refreshCollections(): Promise<void> {
		const generation = this.generation;
		await Promise.all([...this.providers].map(async ([extension, providers]) => {
			const read = [...providers].at(-1)!;
			const collection = await read();
			if (!this.isDisposed && generation === this.generation && this.providers.get(extension) === providers && [...providers].at(-1) === read) this.set(extension, collection);
		}));
	}

	private publish(): void {
		const persistent = [...this.values].filter(([, collection]) => collection.persistent).map(([extension, collection]) => [extension, serializeEnvironmentVariableCollection(collection.map), serializeEnvironmentDescriptionMap(collection.descriptionMap ?? new Map())]);
		this.storage.store(storageKey, JSON.stringify(persistent), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.changed.fire(this.mergedCollection);
	}

	private restore(): void {
		const stored = this.storage.get(storageKey, StorageScope.WORKSPACE);
		if (!stored) return;
		try {
			const entries: unknown = JSON.parse(stored);
			if (!Array.isArray(entries) || entries.length > 256) return;
			for (const entry of entries) {
				if (!Array.isArray(entry) || (entry.length !== 2 && entry.length !== 3) || typeof entry[0] !== 'string') continue;
				const map = deserializeEnvironmentVariableCollection(entry[1]);
				const descriptionMap = entry.length === 3 ? deserializeEnvironmentDescriptionMap(entry[2]) : undefined;
				this.values.set(entry[0], { persistent: true, map, descriptionMap });
			}
		} catch { /* Invalid persisted snapshots cannot become process input. */ }
	}

	protected override disposeCore(): void {
		this.providers.clear();
		this.values.clear();
		super.disposeCore();
	}
}
