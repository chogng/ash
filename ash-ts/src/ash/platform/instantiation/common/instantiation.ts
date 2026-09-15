import {
	Disposable,
	type IDisposable,
} from "../../../base/common/lifecycle.js";
import { InstantiationType } from './extensions.js';

/** A typed service key that also declares a constructor dependency. */
export interface ServiceIdentifier<T> {
	(target: object, propertyKey: string | symbol | undefined, parameterIndex: number): void;
	readonly description: string;
	readonly __serviceType?: T;
}

const constructorDependencies = new WeakMap<Function, Map<number, ServiceIdentifier<unknown>>>();

/** Constructor accepted by synchronous instance descriptors. */
export type Constructor<T> = new (...args: any[]) => T;

/** Creates a stable typed service key. Export and reuse the returned value. */
export function createServiceIdentifier<T>(id: string): ServiceIdentifier<T> {
	const identifier = ((target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
		if (typeof target !== 'function' || propertyKey !== undefined || !Number.isInteger(parameterIndex) || parameterIndex < 0) {
			throw new TypeError('Service decorators must annotate constructor parameters');
		}
		let dependencies = constructorDependencies.get(target);
		if (!dependencies) {
			dependencies = new Map();
			constructorDependencies.set(target, dependencies);
		}
		if (dependencies.has(parameterIndex)) {
			throw new TypeError(`Duplicate service at parameter ${parameterIndex}`);
		}
		dependencies.set(parameterIndex, identifier);
	}) as ServiceIdentifier<T>;
	Object.defineProperty(identifier, 'description', { value: id });
	identifier.toString = () => id;
	return identifier;
}

/** VS Code-compatible name for declaring a service identifier. */
export const createDecorator = createServiceIdentifier;

/** Provides command handlers with the services of the active application. */
export interface ServicesAccessor {
	get<T>(id: ServiceIdentifier<T>): T;
	getOptional<T>(id: ServiceIdentifier<T>): T | undefined;
}

/** Options for registering a singleton factory. */
export interface SingletonRegistrationOptions {
	readonly instantiation?: InstantiationType;
}

/** Factory used by the service container. */
export type ServiceFactory<T> = (accessor: ServicesAccessor) => T;

/** Options that describe arguments owned by a synchronous contribution. */
export interface ServiceConstructionDescriptorOptions {
	readonly staticArguments?: readonly unknown[];
	readonly serviceDependencies?: readonly ServiceIdentifier<unknown>[];
}

/**
 * Describes how the instantiation service constructs a contributed object.
 *
 * Static arguments are placed before call-site arguments. Resolved services
 * are appended last. Constructor decorators declare service positions;
 * serviceDependencies declares the order for undecorated constructors.
 */
export class ServiceConstructionDescriptor<T> {
	readonly staticArguments: readonly unknown[];
	readonly serviceDependencies: readonly ServiceIdentifier<unknown>[];

	constructor(
		readonly ctor: Constructor<T>,
		options: ServiceConstructionDescriptorOptions = {},
	) {
		this.staticArguments = Object.freeze([
			...(options.staticArguments ?? []),
		]);
		this.serviceDependencies = Object.freeze([
			...(options.serviceDependencies ?? []),
		]);
	}
}

export class ServiceCollection {
	private readonly entriesById = new Map<ServiceIdentifier<unknown>, unknown>();

	constructor(...entries: readonly (readonly [ServiceIdentifier<unknown>, unknown])[]) {
		for (const [id, value] of entries) this.set(id, value);
	}

	set<T>(id: ServiceIdentifier<T>, value: T): T | undefined {
		const previous = this.entriesById.get(id) as T | undefined;
		this.entriesById.set(id, value);
		return previous;
	}

	has<T>(id: ServiceIdentifier<T>): boolean { return this.entriesById.has(id); }
	get<T>(id: ServiceIdentifier<T>): T | undefined { return this.entriesById.get(id) as T | undefined; }
	entries(): IterableIterator<[ServiceIdentifier<unknown>, unknown]> { return this.entriesById.entries(); }
}

/** The service container used by commands, contributions, and views. */
export interface IInstantiationService extends ServicesAccessor {
	createInstance<T>(
		descriptor: ServiceConstructionDescriptor<T> | Constructor<T>,
		...dynamicArguments: unknown[]
	): T;

	createChild(): ServiceContainer;

	invokeFunction<R, TArguments extends unknown[]>(
		fn: (
			accessor: ServicesAccessor,
			...args: TArguments
		) => R,
		...args: TArguments
	): R;
}

export const IInstantiationService =
	createServiceIdentifier<IInstantiationService>("instantiationService");

interface InstanceRegistration<T> {
	readonly kind: "instance";
	readonly value: T;
}

interface FactoryRegistration<T> {
	readonly kind: "singleton" | "transient";
	readonly factory: ServiceFactory<T>;
	value: T | typeof UNINITIALIZED;
}

type ServiceRegistration<T> =
	| InstanceRegistration<T>
	| FactoryRegistration<T>;

const UNINITIALIZED = Symbol("service.uninitialized");

/**
 * Resolves services for one application scope.
 *
 * A child container inherits parent registrations and may override them for
 * its own scope. Singleton factories are lazy by default and disposable
 * values created by this container are owned by the container.
 */
export class ServiceContainer extends Disposable implements IInstantiationService {
	private readonly registrations = new Map<
		ServiceIdentifier<unknown>,
		ServiceRegistration<unknown>
	>();
	private readonly resolving: ServiceIdentifier<unknown>[] = [];

	constructor(private readonly parent?: ServiceContainer) {
		super();
		this.registerInstance(IInstantiationService, this);
	}

	registerInstance<T>(id: ServiceIdentifier<T>, value: T): void {
		this.assertNotDisposed();
		this.assertCanRegister(id);
		this.registrations.set(id, { kind: "instance", value });
	}

	registerSingleton<T>(
		id: ServiceIdentifier<T>,
		factory: ServiceFactory<T>,
		options: SingletonRegistrationOptions = {},
	): void {
		this.assertNotDisposed();
		this.assertCanRegister(id);
		this.registrations.set(id, {
			kind: "singleton",
			factory,
			value: UNINITIALIZED,
		});
		if (options.instantiation === InstantiationType.Eager) this.get(id);
	}

	registerTransient<T>(
		id: ServiceIdentifier<T>,
		factory: ServiceFactory<T>,
	): void {
		this.assertNotDisposed();
		this.assertCanRegister(id);
		this.registrations.set(id, {
			kind: "transient",
			factory,
			value: UNINITIALIZED,
		});
	}

	registerCollection(collection: ServiceCollection): void {
		for (const [id, value] of collection.entries()) this.registerInstance(id, value);
	}

	has<T>(id: ServiceIdentifier<T>): boolean {
		return this.registrations.has(id) || this.parent?.has(id) === true;
	}

	get<T>(id: ServiceIdentifier<T>): T {
		this.assertNotDisposed();
		const registration = this.registrations.get(id);
		if (registration) return this.resolveRegistration(id, registration) as T;
		if (this.parent) return this.parent.get(id);
		throw new Error(`Unknown service: ${serviceName(id)}`);
	}

	getOptional<T>(id: ServiceIdentifier<T>): T | undefined {
		this.assertNotDisposed();
		const registration = this.registrations.get(id);
		if (registration) return this.resolveRegistration(id, registration) as T;
		return this.parent?.getOptional(id);
	}

	createChild(): ServiceContainer {
		this.assertNotDisposed();
		return new ServiceContainer(this);
	}

	createInstance<T>(
		descriptor: ServiceConstructionDescriptor<T> | Constructor<T>,
		...dynamicArguments: unknown[]
	): T {
		this.assertNotDisposed();
		const construction = typeof descriptor === 'function' ? new ServiceConstructionDescriptor(descriptor) : descriptor;
		const explicitArguments = [...construction.staticArguments, ...dynamicArguments];
		let ctor: Function | null = construction.ctor;
		while (ctor && !constructorDependencies.has(ctor)) {
			ctor = Object.getPrototypeOf(ctor);
		}
		const dependencies = ctor ? constructorDependencies.get(ctor) : undefined;
		let serviceIds = construction.serviceDependencies;
		if (dependencies) {
			if (serviceIds.length > 0) {
				throw new TypeError('Service dependencies must be declared only in the constructor');
			}
			const ordered = [...dependencies.entries()].sort(([a], [b]) => a - b);
			for (const [offset, [index, id]] of ordered.entries()) {
				if (index !== explicitArguments.length + offset) {
					throw new TypeError(`Invalid constructor arguments for ${construction.ctor.name}: expected service ${id} at parameter ${index}`);
				}
			}
			serviceIds = ordered.map(([, id]) => id);
		}
		return Reflect.construct(construction.ctor, [
			...explicitArguments,
			...serviceIds.map(id => this.get(id)),
		]) as T;
	}

	invokeFunction<R, TArguments extends unknown[]>(
		fn: (
			accessor: ServicesAccessor,
			...args: TArguments
		) => R,
		...args: TArguments
	): R {
		this.assertNotDisposed();
		let active = true;
		const accessor: ServicesAccessor = {
			get: <T>(id: ServiceIdentifier<T>): T => {
				if (!active) throw new ReferenceError("Service accessor is only valid during invocation");
				return this.get(id);
			},
			getOptional: <T>(id: ServiceIdentifier<T>): T | undefined => {
				if (!active) throw new ReferenceError("Service accessor is only valid during invocation");
				return this.getOptional(id);
			},
		};
		try {
			return fn(accessor, ...args);
		} finally {
			active = false;
		}
	}

	protected override disposeCore(): void {
		this.registrations.clear();
		this.resolving.length = 0;
		super.disposeCore();
	}

	private assertCanRegister<T>(id: ServiceIdentifier<T>): void {
		if (this.registrations.has(id)) {
			throw new Error(`Service '${serviceName(id)}' is already registered in this scope`);
		}
	}

	private resolveRegistration<T>(
		id: ServiceIdentifier<T>,
		registration: ServiceRegistration<T>,
	): T {
		if (registration.kind === "instance") return registration.value;
		if (registration.kind === "singleton" && registration.value !== UNINITIALIZED) {
			return registration.value;
		}
		this.beginResolving(id);
		try {
			const value = registration.factory(this);
			if (registration.kind === "singleton") {
				registration.value = value;
				if (isDisposable(value)) this._register(value);
			}
			return value;
		} finally {
			this.resolving.pop();
		}
	}

	private beginResolving(id: ServiceIdentifier<unknown>): void {
		const cycleStart = this.resolving.indexOf(id);
		if (cycleStart >= 0) {
			const cycle = [...this.resolving.slice(cycleStart), id]
				.map(serviceName)
				.join(" -> ");
			throw new Error(`Cyclic service dependency: ${cycle}`);
		}
		this.resolving.push(id);
	}
}

function isDisposable(value: unknown): value is IDisposable {
	return typeof value === "object"
		&& value !== null
		&& typeof (value as IDisposable).dispose === "function"
		&& typeof (value as IDisposable)[Symbol.dispose] === "function";
}

function serviceName(id: ServiceIdentifier<unknown>): string {
	return id.description ?? String(id);
}
