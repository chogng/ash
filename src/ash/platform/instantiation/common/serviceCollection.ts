import type { ServiceIdentifier } from './instantiation.js';
import type { SyncDescriptor } from './descriptors.js';

/** A live registration collection. Instances supplied by its owner are borrowed. */
export class ServiceCollection {
	private readonly entriesById = new Map<ServiceIdentifier<unknown>, unknown>();

	constructor(...entries: readonly (readonly [ServiceIdentifier<unknown>, unknown])[]) {
		for (const [id, value] of entries) {
			this.set(id, value);
		}
	}

	public set<T>(id: ServiceIdentifier<T>, value: T | SyncDescriptor<T>): T | SyncDescriptor<T> | undefined {
		const previous = this.get(id);
		this.entriesById.set(id, value);
		return previous;
	}

	public has(id: ServiceIdentifier<unknown>): boolean {
		return this.entriesById.has(id);
	}

	public get<T>(id: ServiceIdentifier<T>): T | SyncDescriptor<T> | undefined {
		return this.entriesById.get(id) as T | SyncDescriptor<T> | undefined;
	}

	public entries(): IterableIterator<[ServiceIdentifier<unknown>, unknown]> {
		return this.entriesById.entries();
	}
}
