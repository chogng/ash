/** String-keyed cleanup handle that can cross a contextBridge boundary. */
export interface DisposableHandle {
	dispose(): void;
}
