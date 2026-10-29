import { AbstractDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { observableValue, type IObservable, type IReader, type ITransaction } from '../../../base/common/observable.js';
import { IStorageService, type StorageScope, type StorageTarget } from '../../storage/common/storage.js';

interface IObservableMementoOpts<T> {
	readonly defaultValue: T;
	readonly key: string;
	readonly toStorage: (value: T) => string;
	readonly fromStorage: (value: string) => T;
}

export function observableMemento<T>(
	opts: IObservableMementoOpts<T>,
): (scope: StorageScope, target: StorageTarget, storageService: IStorageService) => ObservableMemento<T> {
	return (scope, target, storageService) => new ObservableMemento(opts, scope, target, storageService);
}

/** Storage owns persistence; this object owns the observable value and its subscription. Values must be immutable. */
export class ObservableMemento<T> extends AbstractDisposable implements IObservable<T> {
	private readonly value;
	public readonly onDidChange;
	private writing = false;
	private readonly storageListener: IDisposable;

	constructor(
		private readonly opts: IObservableMementoOpts<T>,
		private readonly scope: StorageScope,
		private readonly target: StorageTarget,
		@IStorageService private readonly storage: IStorageService,
	) {
		super();
		this.value = observableValue(opts.key, this.readStorage());
		this.onDidChange = this.value.onDidChange;
		this.storageListener = storage.onDidChangeValue(event => {
			if (!this.writing && event.scope === scope && event.key === opts.key) {
				this.value.set(this.readStorage());
			}
		});
	}

	public get(): T {
		return this.value.get();
	}

	public read(reader: IReader | undefined): T {
		return this.value.read(reader);
	}

	public map<TMapped>(mapValue: (value: T, reader: IReader) => TMapped): IObservable<TMapped> {
		return this.value.map(mapValue);
	}

	public set(value: T, transaction?: ITransaction): void {
		this.assertNotDisposed();
		if (Object.is(value, this.get())) {
			return;
		}
		const serialized = this.opts.toStorage(value);
		// Ignore our synchronous storage event so decoding cannot replace the caller's object identity.
		this.writing = true;
		try {
			this.storage.store(this.opts.key, serialized, this.scope, this.target);
		} finally {
			this.writing = false;
		}
		this.value.set(value, transaction);
	}

	protected override disposeCore(): void {
		this.storageListener.dispose();
	}

	private readStorage(): T {
		const serialized = this.storage.get(this.opts.key, this.scope);
		if (serialized === undefined) {
			return this.opts.defaultValue;
		}
		try {
			return this.opts.fromStorage(serialized);
		} catch {
			return this.opts.defaultValue;
		}
	}
}
