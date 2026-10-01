import type { DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import type { Constructor, SyncDescriptor } from './descriptors.js';
import type { ServiceCollection } from './serviceCollection.js';
import type { InstantiationService } from './instantiationService.js';
import type { InstantiationType } from './extensions.js';

/** A typed service key that also declares a constructor dependency. */
export interface ServiceIdentifier<T> {
	(target: object, propertyKey: string | symbol | undefined, parameterIndex: number): void;
	readonly description: string;
	readonly __serviceType?: T;
}

const identifiers = new Map<string, ServiceIdentifier<unknown>>();
const constructorDependencies = new WeakMap<Function, Map<number, ServiceIdentifier<unknown>>>();


/** Creates a stable typed service key. Export and reuse the returned value. */
export function createServiceIdentifier<T>(id: string): ServiceIdentifier<T> {
	const existing = identifiers.get(id);
	if (existing) {
		return existing as ServiceIdentifier<T>;
	}
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
	identifiers.set(id, identifier);
	return identifier;
}

/** VS Code-compatible name for declaring a service identifier. */
export const createDecorator = createServiceIdentifier;

/** Refines a service contract without creating another registration key. */
export function refineServiceDecorator<TBase, T extends TBase>(identifier: ServiceIdentifier<TBase>): ServiceIdentifier<T> {
	return identifier as ServiceIdentifier<T>;
}

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

export namespace _util {
	export function getServiceDependencies(constructor: Function): readonly { readonly index: number; readonly id: ServiceIdentifier<unknown> }[] {
		let current: Function | null = constructor;
		while (current && !constructorDependencies.has(current)) {
			current = Object.getPrototypeOf(current);
		}
		const dependencies = current ? constructorDependencies.get(current) : undefined;
		return [...(dependencies ?? [])].sort(([a], [b]) => a - b).map(([index, id]) => ({ index, id }));
	}
}

/** The service scope used by commands, contributions, and views. */
export interface IInstantiationService extends ServicesAccessor, IDisposable {
	createInstance<T>(descriptor: SyncDescriptor<T> | Constructor<T>, ...dynamicArguments: unknown[]): T;
	createChild(services?: ServiceCollection, store?: DisposableStore): InstantiationService;
	invokeFunction<R, TArguments extends unknown[]>(fn: (accessor: ServicesAccessor, ...args: TArguments) => R, ...args: TArguments): R;
}

export const IInstantiationService = createDecorator<IInstantiationService>('instantiationService');
