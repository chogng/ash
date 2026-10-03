import { Emitter } from '../../../../base/common/event.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { isRecord } from '../../../../base/common/types.js';
import { disposableWindowInterval } from '../../../../base/browser/scheduler.js';
import type { IChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { StorageScope, StorageTarget, WillSaveStateReason, type IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, type StorageValue } from '../../../../platform/storage/common/storage.js';
import { validateStorageEntries, validateStorageSnapshot, type IStorageIdentity, type IStorageEntry, type IStorageSnapshot } from '../../../../platform/storage/common/storageIpc.js';

interface StorageOptions {
	readonly applicationId: string;
	readonly workspaceId: string;
	readonly profileId?: string;
	readonly ownerWindow: Window;
}

/** Window cache with ordered key writes to the single Desktop persistence owner. */
export class NativeWorkbenchStorageService extends Disposable implements IStorageService {
	private readonly changes = this._register(new Emitter<IStorageValueChangeEvent>());
	public readonly onDidChangeValue = this.changes.event;
	private readonly saves = this._register(new Emitter<IWillSaveStateEvent>());
	public readonly onWillSaveState = this.saves.event;
	private readonly snapshots = new Map<StorageScope, IStorageSnapshot>();
	private readonly subscriptions = this._register(new MutableDisposable<DisposableStore>());
	private readonly pendingEntries = new Map<string, IStorageEntry | null>();
	private writes: Promise<void> = Promise.resolve();
	private readonly channel: IChannel;
	private workspaceId: string;

	constructor(private readonly options: StorageOptions, @IMainProcessService mainProcessService: IMainProcessService) {
		super();
		this.workspaceId = options.workspaceId;
		this.channel = mainProcessService.getChannel('storage');
		this._register(disposableWindowInterval(options.ownerWindow, () => { void this.flush().catch(onUnexpectedError); }, 5_000));
	}

	public async initialize(): Promise<void> {
		this.assertNotDisposed();
		const resources = new DisposableStore();
		this.subscriptions.value = resources;
		for (const scope of [StorageScope.APPLICATION, StorageScope.PROFILE, StorageScope.WORKSPACE]) {
			const identity = this.identity(scope);
			resources.add(this.channel.listen<unknown>('onDidChangeStorage', identity)(value => this.accept(validateStorageSnapshot(value))));
			const key = `ash.${encodeURIComponent(identity.applicationId)}.storage.${scope}${scope === StorageScope.APPLICATION ? '' : `.${encodeURIComponent(identity.id)}`}`;
			const legacy = this.options.ownerWindow.localStorage.getItem(key);
			let entries: Record<string, IStorageEntry> | undefined;
			if (legacy !== null) {
				const document: unknown = JSON.parse(legacy);
				if (!isRecord(document) || document.version !== 1) { throw new TypeError('Invalid legacy Desktop storage'); }
				entries = validateStorageEntries(document.entries);
			}
			const snapshot = validateStorageSnapshot(await this.channel.call('getItems', { identity, legacy: entries }));
			this.assertNotDisposed();
			this.accept(snapshot);
			if (legacy !== null) { this.options.ownerWindow.localStorage.removeItem(key); }
		}
	}

	public get(key: string, scope: StorageScope, fallbackValue: string): string;
	public get(key: string, scope: StorageScope): string | undefined;
	public get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined { return this.snapshot(scope).entries[key]?.value ?? fallbackValue; }
	public getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	public getBoolean(key: string, scope: StorageScope): boolean | undefined;
	public getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.get(key, scope);
		if (value === 'true') { return true; }
		if (value === 'false') { return false; }
		return fallbackValue;
	}
	public getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	public getNumber(key: string, scope: StorageScope): number | undefined;
	public getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = this.get(key, scope);
		if (value === undefined || !value.trim()) { return fallbackValue; }
		const number = Number(value);
		return Number.isFinite(number) ? number : fallbackValue;
	}
	public store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void {
		if (value === null || value === undefined) { this.remove(key, scope); return; }
		this.update(key, scope, validateStorageEntries({ [key]: { value: String(value), target } })[key]!);
	}
	public remove(key: string, scope: StorageScope): void { this.update(key, scope, null); }
	public keys(scope: StorageScope, target: StorageTarget): readonly string[] { return Object.keys(this.snapshot(scope).entries).filter(key => this.snapshot(scope).entries[key]!.target === target).sort(); }
	public isNew(scope: StorageScope): boolean { return this.snapshot(scope).isNew; }
	public async flush(reason = WillSaveStateReason.PERIODIC): Promise<void> {
		this.saves.fire({ reason });
		await this.writes;
		await this.channel.call('flush');
	}
	public async switchWorkspace(workspaceId: string): Promise<void> {
		await this.flush(WillSaveStateReason.WORKSPACE_CHANGE);
		this.workspaceId = workspaceId;
		await this.initialize();
	}

	private identity(scope: StorageScope): IStorageIdentity {
		let id = 'application';
		if (scope === StorageScope.PROFILE) { id = this.options.profileId ?? 'default'; }
		if (scope === StorageScope.WORKSPACE) { id = this.workspaceId; }
		return { applicationId: this.options.applicationId, scope, id };
	}
	private snapshot(scope: StorageScope): IStorageSnapshot {
		const snapshot = this.snapshots.get(scope);
		if (!snapshot) { throw new Error('Desktop storage is not initialized'); }
		return snapshot;
	}
	private update(key: string, scope: StorageScope, entry: IStorageEntry | null): void {
		this.assertNotDisposed();
		if (!key.trim()) { throw new TypeError('Invalid storage key'); }
		const current = this.snapshot(scope);
		const previous = current.entries[key];
		if (previous?.value === entry?.value && previous?.target === entry?.target) { return; }
		const entries: Record<string, IStorageEntry> = Object.assign(Object.create(null), current.entries);
		if (entry) { entries[key] = entry; } else { delete entries[key]; }
		this.snapshots.set(scope, { ...current, entries });
		const pendingKey = `${scope}:${key}`;
		this.pendingEntries.set(pendingKey, entry);
		this.changes.fire({ key, scope, target: entry?.target, external: false });
		// Send before navigation can disconnect the port; Main serializes mutations, not window replies.
		const write = this.channel.call('updateItems', { identity: current.identity, key, entry }).then(value => {
			const result = validateStorageSnapshot(value);
			if (this.pendingEntries.get(pendingKey) === entry) { this.pendingEntries.delete(pendingKey); }
			this.accept(result);
		});
		this.writes = Promise.all([this.writes, write]).then(() => undefined);
		void this.writes.catch(onUnexpectedError);
	}
	private accept(snapshot: IStorageSnapshot): void {
		if (snapshot.identity.id !== this.identity(snapshot.identity.scope).id) { return; }
		const scope = snapshot.identity.scope;
		const previous = this.snapshots.get(scope);
		const sameIdentity = previous?.identity.id === snapshot.identity.id;
		if (sameIdentity && snapshot.revision < previous.revision) { return; }
		const entries: Record<string, IStorageEntry> = Object.assign(Object.create(null), snapshot.entries);
		for (const key of new Set([...Object.keys(previous?.entries ?? {}), ...Object.keys(entries)])) {
			if (this.pendingEntries.has(`${scope}:${key}`)) {
				const pending = this.pendingEntries.get(`${scope}:${key}`);
				if (pending) { entries[key] = pending; } else { delete entries[key]; }
			}
		}
		this.snapshots.set(scope, { ...snapshot, isNew: sameIdentity ? previous.isNew : snapshot.isNew, entries });
		if (!previous) { return; }
		for (const key of new Set([...Object.keys(previous.entries), ...Object.keys(entries)])) {
			if (previous.entries[key]?.value !== entries[key]?.value || previous.entries[key]?.target !== entries[key]?.target) {
				this.changes.fire({ key, scope, target: entries[key]?.target, external: true });
			}
		}
	}
}
