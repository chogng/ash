import type { Event } from '../../base/common/event.js';
import { validateJsonValue } from '../../base/common/jsonValue.js';
import type { DisposableStore } from '../../base/common/lifecycle.js';
import { isRecord } from '../../base/common/types.js';
import { type IStorageService, type IStorageValueChangeEvent, StorageScope, StorageTarget } from '../../platform/storage/common/storage.js';

interface MementoScope<T extends object> {
	readonly state: Partial<T>;
	readonly target: StorageTarget;
}

/** Owns scoped component state; consumers own its schema and when it is saved or reloaded. */
export class Memento<T extends object = object> {
	private readonly storageKey: string;
	private readonly scopes = new Map<StorageScope, MementoScope<T>>();

	constructor(id: string, private readonly storageService: IStorageService) {
		if (!/^[A-Za-z][A-Za-z0-9.-]{0,127}$/.test(id)) {
			throw new TypeError(`Invalid Workbench Memento ID: ${id}`);
		}
		this.storageKey = `memento/${id}`;
	}

	public getMemento(scope: StorageScope, target: StorageTarget): Partial<T> {
		let entry = this.scopes.get(scope);
		if (!entry) {
			entry = { state: this.load(scope), target };
			this.scopes.set(scope, entry);
		}
		return entry.state;
	}

	public onDidChangeValue(scope: StorageScope, disposables: DisposableStore): Event<IStorageValueChangeEvent> {
		return (listener, thisArgs, listenerDisposables) => disposables.add(this.storageService.onDidChangeValue(event => {
			if (event.scope === scope && event.key === this.storageKey) {
				listener.call(thisArgs, event);
			}
		}, undefined, listenerDisposables));
	}

	public saveMemento(): void {
		for (const [scope, { state, target }] of this.scopes) {
			if (Object.keys(state).length === 0) {
				this.storageService.remove(this.storageKey, scope);
			} else {
				this.storageService.store(this.storageKey, JSON.stringify(validateJsonValue(state, { path: this.storageKey })), scope, target);
			}
		}
	}

	public reloadMemento(scope: StorageScope): void {
		const entry = this.scopes.get(scope);
		if (!entry) {
			return;
		}
		const state = this.load(scope);
		// Callers retain this object, including after a workspace switch.
		for (const key of Object.keys(entry.state)) {
			delete entry.state[key as keyof T];
		}
		Object.assign(entry.state, state);
	}

	private load(scope: StorageScope): Partial<T> {
		const stored = this.storageService.get(this.storageKey, scope);
		if (stored === undefined) {
			return {};
		}
		const state: unknown = validateJsonValue(JSON.parse(stored), { path: this.storageKey });
		if (!isRecord(state)) {
			throw new TypeError(`${this.storageKey} must contain an object`);
		}
		return state as Partial<T>;
	}
}