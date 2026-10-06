export type Constructor<T> = new (...args: any[]) => T;

/** Static arguments belong to the instance; service arguments come from constructor decorators. */
export class SyncDescriptor<T> {
	constructor(
		public readonly ctor: Constructor<T>,
		public readonly staticArguments: readonly unknown[] = [],
		public readonly supportsDelayedInstantiation: boolean = false,
	) { }
}

export interface SyncDescriptor0<T> {
	readonly ctor: new () => T;
}
