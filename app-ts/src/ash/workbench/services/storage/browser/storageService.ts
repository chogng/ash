import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { isRecord } from "../../../../base/common/types.js";
import { addDisposableListener } from "../../../../base/browser/dom.js";
import { disposableWindowInterval } from "../../../../base/browser/scheduler.js";
import { type IStorageService, type IStorageValueChangeEvent, type IWillSaveStateEvent, StorageScope, StorageTarget, type StorageValue, WillSaveStateReason } from "../../../../platform/storage/common/storage.js";

interface StoredEntry {
	readonly value: string;
	readonly target: StorageTarget;
}

interface StoredDocument {
	readonly version: 1;
	readonly entries: Readonly<Record<string, StoredEntry>>;
}

export interface BrowserStorageServiceOptions {
	readonly ownerWindow: Window;
	readonly applicationId: string;
	readonly workspaceId: string;
	readonly profileId?: string;
	readonly backend?: Storage;
	readonly flushInterval?: number;
	readonly onError?: (error: unknown) => void;
}

/**
 * Browser storage adapter for small scoped Workbench state.
 *
 * Each scope is one versioned localStorage document. Failed persistence falls
 * back to the in-memory projection so storage availability never blocks UI.
 */
export class BrowserStorageService extends Disposable implements IStorageService {
	private readonly _onDidChangeValue = this._register(new Emitter<IStorageValueChangeEvent>());
	private readonly _onWillSaveState = this._register(new Emitter<IWillSaveStateEvent>());
	private readonly ownerWindow: Window;
	private readonly backend: Storage | undefined;
	private readonly onError: (error: unknown) => void;
	private readonly namespace: string;
	private readonly applicationStorageKey: string;
	private readonly profileStorageKey: string;
	private workspaceStorageKey: string;
	private readonly entries = new Map<StorageScope, Map<string, StoredEntry>>();
	private readonly newStorageKeys = new Map<string, boolean>();

	readonly onDidChangeValue = this._onDidChangeValue.event;
	readonly onWillSaveState = this._onWillSaveState.event;

	constructor(options: BrowserStorageServiceOptions) {
		super();
		this.ownerWindow = options.ownerWindow;
		this.onError = options.onError ?? ((error) => console.error("Failed to access browser storage", error));
		validateIdentifier(options.applicationId, "application");
		validateIdentifier(options.workspaceId, "workspace");
		const profileId = options.profileId ?? "default";
		validateIdentifier(profileId, "profile");
		const flushInterval = options.flushInterval ?? 5_000;
		if (!Number.isFinite(flushInterval) || flushInterval < 0) {
			throw new RangeError("Browser storage flush interval must be non-negative and finite");
		}
		this.namespace = `ash.${encodeURIComponent(options.applicationId)}.storage`;
		this.applicationStorageKey = `${this.namespace}.application`;
		this.profileStorageKey = `${this.namespace}.profile.${encodeURIComponent(profileId)}`;
		this.workspaceStorageKey = workspaceStorageKey(this.namespace, options.workspaceId);
		this.backend = options.backend ?? readLocalStorage(this.ownerWindow, this.onError);
		for (const scope of storageScopes) {
			this.entries.set(scope, this.load(scope));
		}

		this._register(addDisposableListener(this.ownerWindow, "storage", (event: StorageEvent) => this.handleStorageEvent(event)));

		if (flushInterval > 0) {
			this._register(disposableWindowInterval(this.ownerWindow, () => {
				void this.flush(WillSaveStateReason.PERIODIC);
			}, flushInterval));
		}
		this._register(toDisposable(() => {
			void this.flush(WillSaveStateReason.SHUTDOWN);
		}));
	}

	get(key: string, scope: StorageScope, fallbackValue: string): string;
	get(key: string, scope: StorageScope): string | undefined;
	get(key: string, scope: StorageScope, fallbackValue?: string): string | undefined {
		validateKey(key);
		return this.scopeEntries(scope).get(key)?.value ?? fallbackValue;
	}

	getBoolean(key: string, scope: StorageScope, fallbackValue: boolean): boolean;
	getBoolean(key: string, scope: StorageScope): boolean | undefined;
	getBoolean(key: string, scope: StorageScope, fallbackValue?: boolean): boolean | undefined {
		const value = this.get(key, scope);
		if (value === "true") return true;
		if (value === "false") return false;
		return fallbackValue;
	}

	getNumber(key: string, scope: StorageScope, fallbackValue: number): number;
	getNumber(key: string, scope: StorageScope): number | undefined;
	getNumber(key: string, scope: StorageScope, fallbackValue?: number): number | undefined {
		const value = this.get(key, scope);
		if (value !== undefined && value.trim().length > 0) {
			const number = Number(value);
			if (Number.isFinite(number)) return number;
		}
		return fallbackValue;
	}

	store(key: string, value: StorageValue, scope: StorageScope, target: StorageTarget): void {
		validateKey(key);
		validateTarget(target);
		if (value === undefined || value === null) {
			this.remove(key, scope);
			return;
		}
		const nextEntry = { value: String(value), target };
		const current = this.scopeEntries(scope);
		const previous = current.get(key);
		if (previous?.value === nextEntry.value && previous.target === target) return;
		const next = new Map(current);
		next.set(key, nextEntry);
		this.commit(scope, next);
		this._onDidChangeValue.fire({ key, scope, target, external: false });
	}

	remove(key: string, scope: StorageScope): void {
		validateKey(key);
		const current = this.scopeEntries(scope);
		if (!current.has(key)) return;
		const next = new Map(current);
		next.delete(key);
		this.commit(scope, next);
		this._onDidChangeValue.fire({ key, scope, target: undefined, external: false });
	}

	keys(scope: StorageScope, target: StorageTarget): readonly string[] {
		validateTarget(target);
		return [...this.scopeEntries(scope)]
			.filter(([, entry]) => entry.target === target)
			.map(([key]) => key)
			.sort();
	}

	isNew(scope: StorageScope): boolean {
		return this.newStorageKeys.get(this.storageKey(scope)) ?? true;
	}

	async flush(reason: WillSaveStateReason = WillSaveStateReason.PERIODIC): Promise<void> {
		this._onWillSaveState.fire({ reason });
	}

	/** Switches the WORKSPACE scope while retaining application and profile state. */
	switchWorkspace(workspaceId: string): void {
		validateIdentifier(workspaceId, "workspace");
		const storageKey = workspaceStorageKey(this.namespace, workspaceId);
		if (storageKey === this.workspaceStorageKey) return;
		const previous = this.scopeEntries(StorageScope.WORKSPACE);
		this.workspaceStorageKey = storageKey;
		const next = this.load(StorageScope.WORKSPACE);
		this.entries.set(StorageScope.WORKSPACE, next);
		for (const key of new Set([...previous.keys(), ...next.keys()])) {
			const before = previous.get(key);
			const after = next.get(key);
			if (before?.value === after?.value && before?.target === after?.target) continue;
			this._onDidChangeValue.fire({
				key,
				scope: StorageScope.WORKSPACE,
				target: after?.target,
				external: true,
			});
		}
	}

	private load(scope: StorageScope): Map<string, StoredEntry> {
		const storageKey = this.storageKey(scope);
		if (!this.backend) {
			this.recordStorageNewness(storageKey, true);
			return new Map();
		}
		try {
			const value = this.backend.getItem(storageKey);
			this.recordStorageNewness(storageKey, value === null);
			return value === null ? new Map() : parseStoredDocument(value);
		} catch (error) {
			this.recordStorageNewness(storageKey, true);
			this.onError(error);
			return new Map();
		}
	}

	private recordStorageNewness(storageKey: string, isNew: boolean): void {
		if (!this.newStorageKeys.has(storageKey)) {
			this.newStorageKeys.set(storageKey, isNew);
		}
	}

	private commit(scope: StorageScope, entries: Map<string, StoredEntry>): void {
		this.entries.set(scope, entries);
		if (!this.backend) return;
		try {
			if (entries.size === 0) {
				this.backend.removeItem(this.storageKey(scope));
			} else {
				this.backend.setItem(this.storageKey(scope), serializeStoredDocument(entries));
			}
		} catch (error) {
			this.onError(error);
		}
	}

	private handleStorageEvent(event: StorageEvent): void {
		if (event.storageArea && this.backend && event.storageArea !== this.backend) return;
		if (!event.key) return;
		const scope = this.scopeForStorageKey(event.key);
		if (!scope) return;
		let next: Map<string, StoredEntry>;
		try {
			next = event.newValue === null ? new Map() : parseStoredDocument(event.newValue);
		} catch (error) {
			this.onError(error);
			next = new Map();
		}
		const previous = this.scopeEntries(scope);
		this.entries.set(scope, next);
		for (const key of new Set([...previous.keys(), ...next.keys()])) {
			const before = previous.get(key);
			const after = next.get(key);
			if (before?.value === after?.value && before?.target === after?.target) continue;
			this._onDidChangeValue.fire({
				key,
				scope,
				target: after?.target,
				external: true,
			});
		}
	}

	private scopeEntries(scope: StorageScope): Map<string, StoredEntry> {
		const entries = this.entries.get(scope);
		if (!entries) throw new TypeError(`Unsupported storage scope: ${scope}`);
		return entries;
	}

	private storageKey(scope: StorageScope): string {
		switch (scope) {
			case StorageScope.APPLICATION:
				return this.applicationStorageKey;
			case StorageScope.PROFILE:
				return this.profileStorageKey;
			case StorageScope.WORKSPACE:
				return this.workspaceStorageKey;
		}
	}

	private scopeForStorageKey(key: string): StorageScope | undefined {
		if (key === this.applicationStorageKey) return StorageScope.APPLICATION;
		if (key === this.profileStorageKey) return StorageScope.PROFILE;
		if (key === this.workspaceStorageKey) return StorageScope.WORKSPACE;
		return undefined;
	}
}

const storageScopes = [
	StorageScope.APPLICATION,
	StorageScope.PROFILE,
	StorageScope.WORKSPACE,
] as const;

function readLocalStorage(ownerWindow: Window, onError: (error: unknown) => void): Storage | undefined {
	try {
		return ownerWindow.localStorage;
	} catch (error) {
		onError(error);
		return undefined;
	}
}

function serializeStoredDocument(entries: ReadonlyMap<string, StoredEntry>): string {
	return JSON.stringify({
		version: 1,
		entries: Object.fromEntries(entries),
	} satisfies StoredDocument);
}

function parseStoredDocument(value: string): Map<string, StoredEntry> {
	const candidate: unknown = JSON.parse(value);
	if (!isRecord(candidate) || candidate.version !== 1 || !isRecord(candidate.entries)) {
		throw new TypeError("Browser storage document is invalid or unsupported");
	}
	const entries = new Map<string, StoredEntry>();
	for (const [key, entry] of Object.entries(candidate.entries)) {
		validateKey(key);
		if (!isRecord(entry) || typeof entry.value !== "string") {
			throw new TypeError(`Browser storage entry is invalid: ${key}`);
		}
		validateTarget(entry.target);
		entries.set(key, { value: entry.value, target: entry.target });
	}
	return entries;
}

function validateIdentifier(value: string, name: string): void {
	if (value.trim().length === 0) {
		throw new TypeError(`Browser storage ${name} ID must be non-empty`);
	}
}

function workspaceStorageKey(namespace: string, workspaceId: string): string {
	return `${namespace}.workspace.${encodeURIComponent(workspaceId)}`;
}

function validateKey(key: string): void {
	if (key.trim().length === 0) {
		throw new TypeError("Storage key must be non-empty");
	}
}

function validateTarget(value: unknown): asserts value is StorageTarget {
	if (value !== StorageTarget.USER && value !== StorageTarget.MACHINE) {
		throw new TypeError("Storage target is invalid");
	}
}
