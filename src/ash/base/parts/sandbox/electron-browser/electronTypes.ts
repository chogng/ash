/** Electron browser-object helpers exposed by the sandbox preload. */
export interface WebUtils {
	/** Returns an empty string for a File without a backing file on disk. */
	getPathForFile(file: File): string;
}
