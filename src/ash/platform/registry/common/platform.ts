import { assert } from '../../../base/common/assert.js';
import { isFunction, isObject } from '../../../base/common/types.js';

export interface IRegistry {
	/** Adds a contribution under a unique identifier. */
	add(id: string, data: any): void;

	/** Returns whether a contribution exists for the identifier. */
	knows(id: string): boolean;

	/** Returns the contribution for the identifier, or `null` when it is unknown. */
	as<T>(id: string): T;
}

class RegistryImpl implements IRegistry {
	private readonly data = new Map<string, any>();

	public add(id: string, data: any): void {
		assert(typeof id === 'string');
		assert(isObject(data));
		assert(!this.data.has(id), 'There is already an extension with this id');
		this.data.set(id, data);
	}

	public knows(id: string): boolean {
		return this.data.has(id);
	}

	public as<T>(id: string): T {
		return (this.data.get(id) || null) as T;
	}

	public dispose(): void {
		this.data.forEach(value => {
			if (isFunction(value.dispose)) value.dispose();
		});
		this.data.clear();
	}
}

export const Registry: IRegistry = new RegistryImpl();
