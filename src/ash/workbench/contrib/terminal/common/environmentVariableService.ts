import { localize } from '../../../../nls.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IEnvironmentVariableMutator, IMergedEnvironmentVariableCollection } from '../../../../platform/terminal/common/environmentVariable.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEnvironmentVariableService, type IEnvironmentVariableCollectionWithPersistence } from './environmentVariable.js';
import { createTerminalEnvironment } from './terminalEnvironment.js';

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
		const mutations = [...this.values].sort(([a], [b]) => a.localeCompare(b)).flatMap(([, collection]) => [...collection.map]);
		return {
			applyToProcessEnvironment: async (env, inherited, caseSensitive, resolve) => {
				const result = await createTerminalEnvironment(env, inherited, mutations, caseSensitive, resolve);
				for (const [key, value] of Object.entries(result)) Object.defineProperty(env, key, { value, enumerable: true, configurable: true, writable: true });
			}
		};
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
		this.values.set(extensionIdentifier, { persistent: collection.persistent, map: new Map(collection.map) });
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
		const persistent = [...this.values].filter(([, collection]) => collection.persistent).map(([extension, collection]) => [extension, [...collection.map]]);
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
				if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') continue;
				const map = deserializeEnvironmentVariableCollection(entry[1]);
				this.values.set(entry[0], { persistent: true, map });
			}
		} catch { /* Invalid persisted snapshots cannot become process input. */ }
	}

	protected override disposeCore(): void {
		this.providers.clear();
		this.values.clear();
		super.disposeCore();
	}
}

/** Decodes external callback and persisted JSON at their shared boundary. */
export function deserializeEnvironmentVariableCollection(value: unknown): ReadonlyMap<string, IEnvironmentVariableMutator> {
	if (!Array.isArray(value) || value.length > 1024) throw new TypeError(localize('terminal.environment.invalidCollection', 'Invalid terminal environment collection.'));
	const map = new Map<string, IEnvironmentVariableMutator>();
	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError(localize('terminal.environment.invalidCollection', 'Invalid terminal environment collection.'));
		const [key, mutator] = entry;
		if (typeof key !== 'string' || !key || key.length > 32768 || /[=\0]/.test(key) || map.has(key) || !mutator || typeof mutator !== 'object' || typeof mutator.value !== 'string' || mutator.value.length > 32768 || mutator.value.includes('\0') || ![1, 2, 3].includes(mutator.type) || Object.keys(mutator).some(key => key !== 'value' && key !== 'type')) throw new TypeError(localize('terminal.environment.invalidCollection', 'Invalid terminal environment collection.'));
		map.set(key, Object.freeze({ value: mutator.value, type: mutator.type }));
	}
	return map;
}
