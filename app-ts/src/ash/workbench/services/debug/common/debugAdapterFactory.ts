import { Emitter, type Event } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";

export interface DebugAdapterExecutable {
	readonly program: string;
	readonly arguments: readonly string[];
}

/** One Debug domain factory contributed by a declarative package or executable Extension Host. */
export interface DebugAdapterFactory {
	readonly type: string;
	readonly label: string;
	readonly sourceId: string;
	createDebugAdapter(): DebugAdapterExecutable;
}

export interface DebugAdapterFactorySource {
	readonly factories: readonly DebugAdapterFactory[];
	readonly onDidChange: Event<readonly DebugAdapterFactory[]>;
	get(type: string): DebugAdapterFactory | undefined;
}

/** One caller-owned factory set that can be atomically replaced. */
export interface DebugAdapterFactoryRegistration extends IDisposable {
	replace(factories: readonly DebugAdapterFactory[]): void;
}

interface OwnedDebugAdapterFactory {
	readonly owner: object;
	readonly factory: DebugAdapterFactory;
}

/** Canonical multi-producer Debug Adapter factory registry. */
export class DebugAdapterFactoryRegistry extends Disposable implements DebugAdapterFactorySource {
	private readonly changeEmitter = this._register(new Emitter<readonly DebugAdapterFactory[]>());
	private readonly entries = new Map<string, OwnedDebugAdapterFactory>();
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
		return this.entries.get(normalizeIdentifier(type, "Debug Adapter type"))?.factory;
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
		const normalized = factories.map(normalizeFactory);
		const types = new Set<string>();
		for (const factory of normalized) {
			const existing = this.entries.get(factory.type);
			if (types.has(factory.type) || existing && existing.owner !== owner) throw new Error(`Debug Adapter type '${factory.type}' is already registered by '${existing?.factory.sourceId ?? factory.sourceId}'`);
			types.add(factory.type);
		}
		const changed = this.deleteOwner(owner) || normalized.length > 0;
		for (const factory of normalized) this.entries.set(factory.type, { owner, factory });
		if (changed) this.updateFactories();
	}

	private deleteOwner(owner: object): boolean {
		let changed = false;
		for (const [type, entry] of this.entries) {
			if (entry.owner !== owner) continue;
			this.entries.delete(type);
			changed = true;
		}
		return changed;
	}

	private updateFactories(): void {
		this.factoriesValue = Object.freeze([...this.entries.values()].map(entry => entry.factory).sort((left, right) => left.type.localeCompare(right.type)));
		this.changeEmitter.fire(this.factoriesValue);
	}

}

export const DebugAdapterFactoriesRegistry = new DebugAdapterFactoryRegistry();

export function createStaticDebugAdapterFactory(type: string, label: string, sourceId: string, executable: DebugAdapterExecutable): DebugAdapterFactory {
	const normalizedExecutable = normalizeExecutable(executable, `Debug Adapter '${type}'`);
	return normalizeFactory({ type, label, sourceId, createDebugAdapter: () => normalizedExecutable });
}

function normalizeFactory(factory: DebugAdapterFactory): DebugAdapterFactory {
	if (!factory || typeof factory !== "object") throw new TypeError("Debug Adapter factory must be an object");
	const type = normalizeIdentifier(factory.type, "Debug Adapter type");
	const label = normalizeText(factory.label, "Debug Adapter label", 256);
	const sourceId = normalizeIdentifier(factory.sourceId, "Debug Adapter source ID");
	if (typeof factory.createDebugAdapter !== "function") throw new TypeError(`Debug Adapter '${type}' must provide a factory`);
	return Object.freeze({
		type,
		label,
		sourceId,
		createDebugAdapter: () => normalizeExecutable(factory.createDebugAdapter.call(factory), `Debug Adapter '${type}'`),
	});
}

function normalizeExecutable(executable: DebugAdapterExecutable, owner: string): DebugAdapterExecutable {
	if (!executable || typeof executable !== "object") throw new TypeError(`${owner} executable must be an object`);
	const program = normalizeText(executable.program, `${owner} program`, 4096);
	if (!Array.isArray(executable.arguments)) throw new TypeError(`${owner} arguments must be an array`);
	const argumentsList = executable.arguments.map((argument, index) => normalizeText(argument, `${owner} argument ${index}`, 4096));
	if (argumentsList.length > 256) throw new RangeError(`${owner} has too many arguments`);
	return Object.freeze({ program, arguments: Object.freeze(argumentsList) });
}

function normalizeIdentifier(value: string, owner: string): string {
	return normalizeText(value, owner, 256);
}

function normalizeText(value: string, owner: string, maximum: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\0")) throw new TypeError(`${owner} must contain 1 to ${maximum} characters without NUL`);
	return value.trim();
}
