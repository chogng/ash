import type { ServiceIdentifier } from './instantiation.js';
import { SyncDescriptor, type Constructor } from './descriptors.js';

const registry: [ServiceIdentifier<unknown>, SyncDescriptor<unknown>][] = [];

export const enum InstantiationType {
	Eager = 0,
	Delayed = 1,
}

export function registerSingleton<T>(id: ServiceIdentifier<T>, ctor: Constructor<T>, supportsDelayedInstantiation: InstantiationType): void;
export function registerSingleton<T>(id: ServiceIdentifier<T>, descriptor: SyncDescriptor<T>): void;
export function registerSingleton<T>(id: ServiceIdentifier<T>, ctorOrDescriptor: Constructor<T> | SyncDescriptor<T>, supportsDelayedInstantiation: InstantiationType = InstantiationType.Delayed): void {
	const descriptor = ctorOrDescriptor instanceof SyncDescriptor
		? ctorOrDescriptor
		: new SyncDescriptor(ctorOrDescriptor, [], supportsDelayedInstantiation === InstantiationType.Delayed);
	if (registry.some(([registered]) => registered === id)) throw new Error(`Singleton service '${String(id.description ?? id)}' is already registered`);
	registry.push([id as ServiceIdentifier<unknown>, descriptor as SyncDescriptor<unknown>]);
}

export function getSingletonServiceDescriptors(): [ServiceIdentifier<unknown>, SyncDescriptor<unknown>][] {
	return registry;
}
