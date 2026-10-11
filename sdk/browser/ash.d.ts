	import type { ISCMProvider, IDisposable, IDecorationsProvider, QuickDiffProvider, URI } from './index.js';
	export const backend: { request<T>(capability: string, method: string, params?: unknown): Promise<T>; state<T>(capability: string, after?: number): Promise<T>; };
	export const editors: { request<T>(payload: unknown): Promise<T>; };
	export const scm: { initialize(): void; registerSCMProvider(provider: ISCMProvider, options: { decorations?: IDecorationsProvider; quickDiff?: QuickDiffProvider; parseUri(value: string): URI; multiDiff?: { metadata: unknown; resolve(resource: URI): Promise<unknown>; }; }): IDisposable; selectRepository(id: string | undefined): void; };
