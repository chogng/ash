/** Browser capability checks shared by file providers and their host. */
export namespace WebFileSystemAccess {
	export function supported(target: typeof globalThis): boolean {
		return typeof Reflect.get(target, 'showDirectoryPicker') === 'function';
	}

	export function isFileSystemHandle(value: unknown): value is FileSystemHandle {
		return typeof value === 'object' && value !== null
			&& ['file', 'directory'].includes(Reflect.get(value, 'kind'))
			&& typeof Reflect.get(value, 'queryPermission') === 'function'
			&& typeof Reflect.get(value, 'requestPermission') === 'function';
	}

	export function isFileSystemFileHandle(handle: FileSystemHandle): handle is FileSystemFileHandle {
		return handle.kind === 'file';
	}

	export function isFileSystemDirectoryHandle(handle: FileSystemHandle): handle is FileSystemDirectoryHandle {
		return handle.kind === 'directory';
	}
}

export namespace WebFileSystemObserver {
	export function supported(target: typeof globalThis): boolean {
		return typeof Reflect.get(target, 'FileSystemObserver') === 'function';
	}
}

export interface FileSystemObserverRecord {
	readonly root: FileSystemHandle;
	readonly changedHandle: FileSystemHandle;
	readonly relativePathComponents: string[];
	readonly relativePathMovedFrom?: string[];
	readonly type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored';
}

export declare class FileSystemObserver {
	constructor(callback: (records: FileSystemObserverRecord[], observer: FileSystemObserver) => void);
	observe(handle: FileSystemHandle, options?: { recursive: boolean; }): Promise<void>;
	unobserve(handle: FileSystemHandle): void;
	disconnect(): void;
}
