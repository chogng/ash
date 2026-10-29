import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import {
	TerminalCapability,
	type AnyTerminalCapabilityChangeEvent,
	type ITerminalCapabilityImplMap,
	type ITerminalCapabilityStore,
} from './capabilities.js';

/** Registers capability implementations without taking ownership of their domain state or lifetime. */
abstract class AbstractTerminalCapabilityStore extends Disposable implements ITerminalCapabilityStore {
	private readonly implementations: Partial<ITerminalCapabilityImplMap> = {};
	private readonly added = this._register(new Emitter<AnyTerminalCapabilityChangeEvent>());
	private readonly removed = this._register(new Emitter<AnyTerminalCapabilityChangeEvent>());
	readonly onDidAddCapability = this.added.event;
	readonly onDidRemoveCapability = this.removed.event;
	readonly onDidChangeCapabilities = Event.map(
		Event.any(this.onDidAddCapability, this.onDidRemoveCapability),
		() => undefined,
	);
	readonly onDidAddCommandDetectionCapability = this.createOnDidAddCapabilityOfTypeEvent(
		TerminalCapability.CommandDetection,
	);
	readonly onDidRemoveCommandDetectionCapability = Event.map(
		this.createOnDidRemoveCapabilityOfTypeEvent(TerminalCapability.CommandDetection),
		() => undefined,
	);
	readonly onDidAddCwdDetectionCapability = this.createOnDidAddCapabilityOfTypeEvent(TerminalCapability.CwdDetection);
	readonly onDidRemoveCwdDetectionCapability = Event.map(
		this.createOnDidRemoveCapabilityOfTypeEvent(TerminalCapability.CwdDetection),
		() => undefined,
	);

	get items(): IterableIterator<TerminalCapability> {
		return Object.keys(this.implementations)
			.map(id => Number(id) as TerminalCapability)
			.values();
	}

	protected registerCapability<T extends TerminalCapability>(id: T, capability: ITerminalCapabilityImplMap[T]): void {
		if (this.isDisposed) return;
		this.implementations[id] = capability;
		this.added.fire({ id, capability } as AnyTerminalCapabilityChangeEvent);
	}

	protected unregisterCapability(id: TerminalCapability): void {
		const capability = this.get(id);
		if (!capability) return;
		delete this.implementations[id];
		this.removed.fire({ id, capability } as AnyTerminalCapabilityChangeEvent);
	}

	has(id: TerminalCapability): boolean {
		return this.get(id) !== undefined;
	}

	get<T extends TerminalCapability>(id: T): ITerminalCapabilityImplMap[T] | undefined {
		return this.implementations[id];
	}

	createOnDidAddCapabilityOfTypeEvent<T extends TerminalCapability>(type: T): Event<ITerminalCapabilityImplMap[T]> {
		return this.capabilityEvent(this.onDidAddCapability, type);
	}

	createOnDidRemoveCapabilityOfTypeEvent<T extends TerminalCapability>(
		type: T,
	): Event<ITerminalCapabilityImplMap[T]> {
		return this.capabilityEvent(this.onDidRemoveCapability, type);
	}

	private capabilityEvent<T extends TerminalCapability>(
		event: Event<AnyTerminalCapabilityChangeEvent>,
		type: T,
	): Event<ITerminalCapabilityImplMap[T]> {
		return (listener, thisArgs, disposables) =>
			event(
				change => {
					if (change.id === type) listener.call(thisArgs, change.capability as ITerminalCapabilityImplMap[T]);
				},
				undefined,
				disposables,
			);
	}

	protected override disposeCore(): void {
		for (const id of this.items) delete this.implementations[id];
		super.disposeCore();
	}
}

export class TerminalCapabilityStore extends AbstractTerminalCapabilityStore {
	add<T extends TerminalCapability>(id: T, capability: ITerminalCapabilityImplMap[T]): void {
		this.registerCapability(id, capability);
	}

	remove(id: TerminalCapability): void {
		this.unregisterCapability(id);
	}
}

/** Combines process and screen capabilities, with earlier stores taking precedence. */
export class TerminalCapabilityStoreMultiplexer extends AbstractTerminalCapabilityStore {
	private readonly sources = new Map<ITerminalCapabilityStore, { lifetime: DisposableStore; leases: number }>();

	add(store: ITerminalCapabilityStore): IDisposable {
		this.assertNotDisposed();
		let source = this.sources.get(store);
		if (!source) {
			source = { lifetime: new DisposableStore(), leases: 0 };
			this.sources.set(store, source);
			source.lifetime.add(store.onDidChangeCapabilities(() => this.refresh()));
		}
		source.leases++;
		this.refresh();
		const registration = source;
		return toDisposable(() => {
			if (this.sources.get(store) !== registration || --registration.leases > 0) return;
			this.sources.delete(store);
			registration.lifetime.dispose();
			this.refresh();
		});
	}

	private refresh(): void {
		if (this.isDisposed) return;
		const ids = new Set(this.items);
		for (const store of this.sources.keys()) for (const id of store.items) ids.add(id);
		for (const id of ids) {
			const selected = [...this.sources.keys()]
				.map(store => store.get(id))
				.find(capability => capability !== undefined);
			if (selected === this.get(id)) continue;
			this.unregisterCapability(id);
			if (selected) this.registerCapability(id, selected);
		}
	}

	protected override disposeCore(): void {
		for (const source of this.sources.values()) source.lifetime.dispose();
		this.sources.clear();
		super.disposeCore();
	}
}
