/**
 * JSON-backed application state available to the Electron main process.
 *
 * Values are returned as `unknown` so each owning feature validates its own
 * persisted schema before use.
 */
export interface IStateService {
	getItem(key: string): unknown;
	setItem(key: string, value: unknown): void;
	removeItem(key: string): void;
	flush(): Promise<void>;
	close(): Promise<void>;
}
