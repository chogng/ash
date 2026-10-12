import type { ExtensionDescriptor } from './extensionService.js';

export interface IExtensionPointUser<T> {
	readonly description: ExtensionDescriptor;
	readonly value: T;
}

export interface IExtensionPoint<T> {
	readonly name: string;
	validate(value: unknown): T;
}

export interface IExtensionPointDescriptor<T> {
	readonly extensionPoint: string;
	readonly validate: (value: unknown) => T;
}

/** Static contribution metadata only. Each extension service owns its committed manifest snapshot. */
class ExtensionsRegistryImpl {
	private readonly points = new Map<string, IExtensionPoint<unknown>>();

	registerExtensionPoint<T>(descriptor: IExtensionPointDescriptor<T>): IExtensionPoint<T> {
		if (this.points.has(descriptor.extensionPoint)) throw new Error(`Extension point already registered: ${descriptor.extensionPoint}`);
		const point = Object.freeze({ name: descriptor.extensionPoint, validate: descriptor.validate });
		this.points.set(point.name, point);
		return point;
	}

	getExtensionPoint<T>(name: string): IExtensionPoint<T> | undefined {
		return this.points.get(name) as IExtensionPoint<T> | undefined;
	}
}

export const ExtensionsRegistry = new ExtensionsRegistryImpl();
