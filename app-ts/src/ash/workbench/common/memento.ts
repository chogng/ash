import { Emitter, type Event } from "../../base/common/event.js";
import { type JsonValue, validateJsonValue } from "../../base/common/jsonValue.js";
import { Disposable } from "../../base/common/lifecycle.js";
import { type IStorageService, type IStorageValueChangeEvent, StorageScope, StorageTarget } from "../../platform/storage/common/storage.js";

const MEMENTO_STORAGE_PREFIX = "memento/";

export interface MementoOptions<TState extends object> {
	readonly id: string;
	readonly scope: StorageScope;
	readonly target: StorageTarget;
	readonly defaultValue: () => TState;
	readonly parse: (value: unknown) => TState;
	readonly serialize: (value: TState) => JsonValue;
	readonly onError?: (error: unknown) => void;
}

export interface MementoChangeEvent<TState extends object> {
	readonly state: Readonly<TState>;
	readonly external: boolean;
}

interface MementoSnapshot<TState extends object> {
	readonly state: TState;
	readonly serialized: string;
	readonly dirty: boolean;
}

/**
 * Owns one Workbench component's private, scoped UI state.
 *
 * Consumers own the persisted schema, validation, and migration through
 * `parse` and `serialize`. Updates remain in memory until the Storage Service
 * announces a save or the consumer explicitly calls `save`. Pending local
 * updates take precedence over external storage changes.
 */
export class Memento<TState extends object> extends Disposable {
	private readonly storageKey: string;
	private readonly scope: StorageScope;
	private readonly target: StorageTarget;
	private readonly defaultValue: () => TState;
	private readonly parse: (value: unknown) => TState;
	private readonly serialize: (value: TState) => JsonValue;
	private readonly onError: (error: unknown) => void;
	private readonly _onDidChange = this._register(new Emitter<MementoChangeEvent<TState>>());
	private stateValue: TState;
	private serializedValue: string;
	private dirty: boolean;

	readonly onDidChange: Event<MementoChangeEvent<TState>> = this._onDidChange.event;

	constructor(
		private readonly storageService: IStorageService,
		options: MementoOptions<TState>,
	) {
		super();
		validateMementoId(options.id);
		this.storageKey = `${MEMENTO_STORAGE_PREFIX}${options.id}`;
		this.scope = options.scope;
		this.target = options.target;
		this.defaultValue = options.defaultValue;
		this.parse = options.parse;
		this.serialize = options.serialize;
		this.onError = options.onError ?? ((error) => {
			console.error(`Failed to restore Workbench Memento '${options.id}'`, error);
		});

		const initial = this.load();
		this.stateValue = initial.state;
		this.serializedValue = initial.serialized;
		this.dirty = initial.dirty;

		this._register(this.storageService.onWillSaveState(() => this.save()));
		this._register(this.storageService.onDidChangeValue((event) => {
			if (event.external && this.affects(event) && !this.dirty) {
				this.reloadExternal();
			}
		}));
	}

	get state(): Readonly<TState> {
		return this.stateValue;
	}

	update(state: TState): void {
		const next = this.normalize(state);
		if (next.serialized === this.serializedValue) return;
		this.stateValue = next.state;
		this.serializedValue = next.serialized;
		this.dirty = true;
		this._onDidChange.fire({ state: this.stateValue, external: false });
	}

	save(): void {
		if (!this.dirty) return;
		this.storageService.store(
			this.storageKey,
			this.serializedValue,
			this.scope,
			this.target,
		);
		this.dirty = false;
	}

	private reloadExternal(): void {
		const next = this.load();
		const changed = next.serialized !== this.serializedValue;
		this.stateValue = next.state;
		this.serializedValue = next.serialized;
		this.dirty = next.dirty;
		if (changed) {
			this._onDidChange.fire({ state: this.stateValue, external: true });
		}
	}

	private load(): MementoSnapshot<TState> {
		const stored = this.storageService.get(this.storageKey, this.scope);
		if (stored === undefined) {
			return { ...this.normalize(this.defaultValue()), dirty: false };
		}
		try {
			const parsed: unknown = JSON.parse(stored);
			const normalized = this.normalize(this.parse(parsed));
			return {
				...normalized,
				dirty: normalized.serialized !== stored,
			};
		} catch (error) {
			this.onError(error);
			return { ...this.normalize(this.defaultValue()), dirty: true };
		}
	}

	private normalize(state: TState): Omit<MementoSnapshot<TState>, "dirty"> {
		const encoded = validateJsonValue(this.serialize(state), {
			path: this.storageKey,
		});
		const normalizedState = this.parse(encoded);
		const normalizedEncoded = validateJsonValue(this.serialize(normalizedState), {
			path: this.storageKey,
		});
		return {
			state: normalizedState,
			serialized: JSON.stringify(normalizedEncoded),
		};
	}

	private affects(event: IStorageValueChangeEvent): boolean {
		return event.key === this.storageKey && event.scope === this.scope;
	}
}

function validateMementoId(id: string): void {
	if (!/^[A-Za-z][A-Za-z0-9.-]{0,127}$/.test(id)) {
		throw new TypeError(`Invalid Workbench Memento ID: ${id}`);
	}
}
