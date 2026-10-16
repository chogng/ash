import { Emitter, type Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IAdapterManager, type DebugAdapterFactory, type DebugAdapterFactoryRegistration, normalizeDebugAdapterFactory } from '../common/debug.js';

interface OwnedDebugAdapterFactory {
	readonly owner: object;
	readonly source: DebugAdapterFactory;
	readonly factory: DebugAdapterFactory;
}

/** Canonical multi-producer Debug Adapter factory registry. */
export class AdapterManager extends Disposable implements IAdapterManager {
	private readonly changeEmitter = this._register(new Emitter<readonly DebugAdapterFactory[]>());
	private readonly entries = new Map<string, readonly OwnedDebugAdapterFactory[]>();
	private factoriesValue: readonly DebugAdapterFactory[] = Object.freeze([]);

	readonly onDidChange: Event<readonly DebugAdapterFactory[]> = this.changeEmitter.event;

	constructor() {
		super();
		this._register(toDisposable(() => {
			this.entries.clear();
			this.factoriesValue = Object.freeze([]);
		}));
	}

	get factories(): readonly DebugAdapterFactory[] {
		this.assertNotDisposed();
		return this.factoriesValue;
	}

	get(type: string): DebugAdapterFactory | undefined {
		this.assertNotDisposed();
		const id = normalizeIdentifier(type, "Debug Adapter type");
		return this.factoriesValue.find(factory => factory.type === id);
	}

	registerFactories(factories: readonly DebugAdapterFactory[]): DebugAdapterFactoryRegistration {
		this.assertNotDisposed();
		const owner = Object.freeze({});
		this.replace(owner, factories);
		let disposed = false;
		const registration = toDisposable(() => {
			if (disposed) return;
			disposed = true;
			if (this.deleteOwner(owner) && !this.isDisposed) this.updateFactories();
		}) as DebugAdapterFactoryRegistration;
		registration.replace = replacement => {
			if (disposed) throw new ReferenceError("Debug Adapter factory registration is already disposed");
			this.assertNotDisposed();
			this.replace(owner, replacement);
		};
		return registration;
	}

	private replace(owner: object, factories: readonly DebugAdapterFactory[]): void {
		if (!Array.isArray(factories)) throw new TypeError("Debug Adapter factories must be an array");
		const normalized = factories.map(factory => {
			const existing = this.entries.get(factory.type)?.find(entry => entry.owner === owner && entry.source === factory);
			return existing?.owner === owner && existing.source === factory ? existing.factory : normalizeDebugAdapterFactory(factory);
		});
		const roles = new Set<string>();
		for (const factory of normalized) {
			const dynamic = factory.createDebugAdapterDescriptor !== undefined;
			const role = JSON.stringify([factory.type, dynamic]);
			const conflicting = this.entries.get(factory.type)?.find(entry =>
				entry.owner !== owner && (entry.factory.createDebugAdapterDescriptor !== undefined) === dynamic);
			if (roles.has(role) || conflicting) {
				throw new Error(`Debug Adapter type '${factory.type}' is already registered by '${conflicting?.factory.sourceId ?? factory.sourceId}'`);
			}
			roles.add(role);
		}
		const previous = [...this.entries.values()].flat().filter(entry => entry.owner === owner);
		if (previous.length === normalized.length && normalized.every(factory => previous.some(entry => entry.factory === factory))) return;
		this.deleteOwner(owner);
		for (const [index, factory] of normalized.entries()) {
			this.entries.set(factory.type, [...(this.entries.get(factory.type) ?? []), { owner, source: factories[index]!, factory }]);
		}
		this.updateFactories();
	}

	private deleteOwner(owner: object): boolean {
		let changed = false;
		for (const [type, entries] of this.entries) {
			const retained = entries.filter(entry => entry.owner !== owner);
			if (retained.length === entries.length) continue;
			if (retained.length) this.entries.set(type, retained);
			else this.entries.delete(type);
			changed = true;
		}
		return changed;
	}

	private updateFactories(): void {
		const previous = this.factoriesValue;
		this.factoriesValue = Object.freeze([...this.entries].map(([type, entries]) => {
			const dynamic = entries.find(entry => entry.factory.createDebugAdapterDescriptor)?.factory;
			const fallback = entries.find(entry => !entry.factory.createDebugAdapterDescriptor)?.factory;
			if (!dynamic || !fallback) return (dynamic ?? fallback)!;
			// The registry is the sole owner of defaults and callbacks. A derived
			// descriptor lookup cannot make a default registration shadow its factory.
			const retained = previous.find(factory => factory.type === type
				&& factory.createDebugAdapter === fallback.createDebugAdapter
				&& factory.createDebugAdapterDescriptor === dynamic.createDebugAdapterDescriptor);
			return retained ?? Object.freeze({
				...dynamic, label: fallback.label, createDebugAdapter: fallback.createDebugAdapter,
			});
		}).sort((left, right) => left.type.localeCompare(right.type)));
		this.changeEmitter.fire(this.factoriesValue);
	}

}

function normalizeIdentifier(value: string, owner: string): string {
	if (typeof value !== 'string' || !value.trim() || value.length > 256 || value.includes('\0')) throw new TypeError(`${owner} must contain 1 to 256 characters without NUL`);
	return value.trim();
}

registerSingleton(IAdapterManager, AdapterManager, InstantiationType.Delayed);
