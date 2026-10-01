import { Disposable, DisposableStore, isDisposable, toDisposable, type IDisposable } from '../../../base/common/lifecycle.js';
import { type Event } from '../../../base/common/event.js';
import { SyncDescriptor, type Constructor } from './descriptors.js';
import { IInstantiationService, _util, type ServiceIdentifier, type ServicesAccessor, type ServiceFactory, type SingletonRegistrationOptions } from './instantiation.js';
import { ServiceCollection } from './serviceCollection.js';
import { InstantiationType } from './extensions.js';

interface FactoryRegistration {
	readonly factory: ServiceFactory<unknown>;
	readonly transient: boolean;
	readonly delayed: boolean;
}

/** Owns services it constructs. Supplied instances and createInstance results belong to their callers. */
export class InstantiationService extends Disposable implements IInstantiationService {
	private readonly children = this._register(new DisposableStore());
	private readonly factories = new Map<ServiceIdentifier<unknown>, FactoryRegistration>();
	private readonly resolving: ServiceIdentifier<unknown>[] = [];
	private parentLifetime: IDisposable | undefined;

	constructor(
		private services = new ServiceCollection(),
		private readonly strict = true,
		private readonly parent?: InstantiationService,
	) {
		super();
		this.services.set(IInstantiationService, this);
	}

	public registerInstance<T>(id: ServiceIdentifier<T>, value: T): void {
		this.assertNotDisposed();
		this.assertCanRegister(id);
		this.services.set(id, value);
	}

	public registerSingleton<T>(id: ServiceIdentifier<T>, factory: ServiceFactory<T>, options: SingletonRegistrationOptions = {}): void {
		this.assertNotDisposed();
		this.assertCanRegister(id);
		this.factories.set(id, { factory, transient: false, delayed: options.instantiation === InstantiationType.Delayed });
	}

	public registerTransient<T>(id: ServiceIdentifier<T>, factory: ServiceFactory<T>): void {
		this.assertNotDisposed();
		this.assertCanRegister(id);
		this.factories.set(id, { factory, transient: true, delayed: false });
	}

	public registerCollection(collection: ServiceCollection): void {
		for (const [id, value] of collection.entries()) {
			this.registerInstance(id, value);
		}
	}

	public has<T>(id: ServiceIdentifier<T>): boolean {
		this.assertNotDisposed();
		return this.services.has(id) || this.factories.has(id) || this.parent?.has(id) === true;
	}

	public get<T>(id: ServiceIdentifier<T>): T {
		if (this.has(id)) {
			return this.getOptional(id) as T;
		}
		if (this.strict) {
			throw new Error(`Unknown service: ${id}`);
		}
		return undefined as T;
	}

	public getOptional<T>(id: ServiceIdentifier<T>): T | undefined {
		this.assertNotDisposed();
		const value = this.services.get(id);
		if (value instanceof SyncDescriptor) {
			this.validateDependencies(value.ctor, new Set([id]));
			return this.resolve(id, () => this.createInstance(value), false, value.supportsDelayedInstantiation) as T;
		}
		if (this.services.has(id)) {
			return value as T;
		}
		const registration = this.factories.get(id);
		if (registration) {
			return this.resolve(id, () => registration.factory(this), registration.transient, registration.delayed) as T;
		}
		return this.parent?.getOptional(id);
	}

	public createChild(services = new ServiceCollection(), store?: DisposableStore): InstantiationService {
		this.assertNotDisposed();
		const child = new InstantiationService(services, this.strict, this);
		// The caller owns the returned child. This handle also closes it with its parent,
		// without registering the same disposable under two owners.
		child.parentLifetime = this.children.add(toDisposable(() => child.dispose()));
		store?.add(child);
		return child;
	}

	public createInstance<T>(descriptor: SyncDescriptor<T> | Constructor<T>, ...dynamicArguments: unknown[]): T {
		this.assertNotDisposed();
		const construction = typeof descriptor === 'function' ? new SyncDescriptor(descriptor) : descriptor;
		const explicitArguments = [...construction.staticArguments, ...dynamicArguments];
		const dependencies = _util.getServiceDependencies(construction.ctor);
		for (const [offset, { index, id }] of dependencies.entries()) {
			if (index !== explicitArguments.length + offset) {
				throw new TypeError(`Invalid constructor arguments for ${construction.ctor.name}: expected service ${id} at parameter ${index}`);
			}
		}
		return Reflect.construct(construction.ctor, [...explicitArguments, ...dependencies.map(({ id }) => this.get(id))]) as T;
	}

	public invokeFunction<R, TArguments extends unknown[]>(fn: (accessor: ServicesAccessor, ...args: TArguments) => R, ...args: TArguments): R {
		this.assertNotDisposed();
		let active = true;
		const accessor: ServicesAccessor = {
			get: <T>(id: ServiceIdentifier<T>): T => {
				if (!active) {
					throw new ReferenceError('Service accessor is only valid during invocation');
				}
				return this.get(id);
			},
			getOptional: <T>(id: ServiceIdentifier<T>): T | undefined => {
				if (!active) {
					throw new ReferenceError('Service accessor is only valid during invocation');
				}
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
		if (this.parentLifetime) {
			this.parent!.children.delete(this.parentLifetime);
			this.parentLifetime.dispose();
			this.parentLifetime = undefined;
		}
		try {
			// Child services may use parent services while releasing their own resources.
			this.children.dispose();
		} finally {
			try {
				super.disposeCore();
			} finally {
				this.services = new ServiceCollection();
				this.factories.clear();
				this.resolving.length = 0;
			}
		}
	}

	private assertCanRegister(id: ServiceIdentifier<unknown>): void {
		if (this.services.has(id) || this.factories.has(id)) {
			throw new Error(`Service '${id}' is already registered in this scope`);
		}
	}

	private validateDependencies(constructor: Function, visited: Set<ServiceIdentifier<unknown>>): void {
		for (const { id } of _util.getServiceDependencies(constructor)) {
			if (visited.has(id)) {
				continue;
			}
			visited.add(id);
			let owner: InstantiationService = this;
			while (!owner.services.has(id) && !owner.factories.has(id) && owner.parent) {
				owner = owner.parent;
			}
			if (!owner.has(id)) {
				throw new Error(`Unknown service: ${id}`);
			}
			const dependency = owner.services.get(id);
			if (dependency instanceof SyncDescriptor) {
				owner.validateDependencies(dependency.ctor, visited);
			}
		}
	}

	private resolve(id: ServiceIdentifier<unknown>, factory: () => unknown, transient: boolean, delayed: boolean): unknown {
		const cycleStart = this.resolving.indexOf(id);
		if (cycleStart >= 0) {
			throw new Error(`Cyclic service dependency: ${[...this.resolving.slice(cycleStart), id].join(' -> ')}`);
		}
		const construct = (): unknown => {
			this.assertNotDisposed();
			this.resolving.push(id);
			try {
				const value = factory();
				if (!transient && isDisposable(value)) {
					this._register(value);
				}
				return value;
			} finally {
				this.resolving.pop();
			}
		};
		const value = delayed ? this.createDelayedService(construct) : construct();
		if (!transient) {
			this.services.set(id, value);
			this.factories.delete(id);
		}
		return value;
	}

	private createDelayedService(construct: () => unknown): object {
		let instance: object | undefined;
		let initializing = false;
		const members = new Map<PropertyKey, unknown>();
		const pending = new Set<{ readonly property: PropertyKey; readonly listener: (event: unknown) => unknown; readonly thisArgs: unknown; subscription?: IDisposable }>();
		this._register(toDisposable(() => {
			for (const entry of pending) {
				entry.subscription?.dispose();
			}
			pending.clear();
			members.clear();
		}));
		const initialize = (): object => {
			this.assertNotDisposed();
			if (initializing) {
				throw new Error('Cyclic delayed service initialization');
			}
			if (!instance) {
				initializing = true;
				try {
					instance = construct() as object;
					for (const entry of pending) {
						const event = Reflect.get(instance, entry.property) as Event<unknown>;
						entry.subscription = event(entry.listener, entry.thisArgs);
					}
				} finally {
					initializing = false;
				}
			}
			return instance;
		};
		return new Proxy({}, {
			get: (_target, property) => {
				this.assertNotDisposed();
				if (members.has(property)) {
					return members.get(property);
				}
				if (typeof property === 'string' && /^(onDid|onWill)/.test(property)) {
					const event: Event<unknown> = (listener, thisArgs, disposables) => {
						this.assertNotDisposed();
						if (instance) {
							return (Reflect.get(instance, property) as Event<unknown>)(listener, thisArgs, disposables);
						}
						const entry = { property, listener, thisArgs, subscription: undefined as IDisposable | undefined };
						pending.add(entry);
						const subscription = toDisposable(() => {
							pending.delete(entry);
							entry.subscription?.dispose();
						});
						if (Array.isArray(disposables)) {
							disposables.push(subscription);
						} else {
							disposables?.add(subscription);
						}
						return subscription;
					};
					members.set(property, event);
					return event;
				}
				const object = initialize();
				const value = Reflect.get(object, property, object);
				if (typeof value !== 'function') {
					return value;
				}
				const method = value.bind(object);
				members.set(property, method);
				return method;
			},
			set: (_target, property, value) => Reflect.set(initialize(), property, value),
			getPrototypeOf: () => Reflect.getPrototypeOf(initialize()),
			has: (_target, property) => Reflect.has(initialize(), property),
		});
	}
}
