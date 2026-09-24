import { ServiceConstructionDescriptor, type Constructor, type ServiceIdentifier } from './instantiation.js';

const registry: [ServiceIdentifier<unknown>, ServiceConstructionDescriptor<unknown>][] = [];

export const enum InstantiationType {
	Eager = 0,
	Delayed = 1,
}

export function registerSingleton<T>(id: ServiceIdentifier<T>, ctor: Constructor<T>, supportsDelayedInstantiation: InstantiationType): void;
export function registerSingleton<T>(id: ServiceIdentifier<T>, descriptor: ServiceConstructionDescriptor<T>): void;
export function registerSingleton<T>(id: ServiceIdentifier<T>, ctorOrDescriptor: Constructor<T> | ServiceConstructionDescriptor<T>, supportsDelayedInstantiation: InstantiationType = InstantiationType.Delayed): void {
	const descriptor = ctorOrDescriptor instanceof ServiceConstructionDescriptor
		? ctorOrDescriptor
		: new ServiceConstructionDescriptor(ctorOrDescriptor, { serviceDependencies: [], staticArguments: [] });
	if (registry.some(([registered]) => registered === id)) throw new Error(`Singleton service '${String(id.description ?? id)}' is already registered`);
	registry.push([id as ServiceIdentifier<unknown>, descriptor as ServiceConstructionDescriptor<unknown>]);
	void supportsDelayedInstantiation;
}

export function getSingletonServiceDescriptors(): [ServiceIdentifier<unknown>, ServiceConstructionDescriptor<unknown>][] {
	return registry;
}
