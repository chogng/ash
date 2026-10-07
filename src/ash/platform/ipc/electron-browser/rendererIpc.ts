import { ipcRenderer } from "../../../base/parts/sandbox/electron-browser/globals.js";
import type { DisposableHandle } from "../common/ipc.js";

export function invoke<TResult>(channel: string, params?: unknown): Promise<TResult> {
	return ipcRenderer.invoke(channel, params) as Promise<TResult>;
}

export function subscribe<T>(channel: string, listener: (value: T) => void): DisposableHandle {
	return ipcRenderer.on(channel, (value) => listener(value as T));
}
