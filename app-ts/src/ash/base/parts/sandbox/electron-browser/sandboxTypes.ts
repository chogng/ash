import type { ISandboxIpcRenderer, ISandboxProcess } from "../common/sandboxTypes.js";

/** Electron helpers that safely translate renderer-owned browser objects. */
export interface ISandboxWebUtils {
	getPathForFile(file: File): string;
}

/** Capabilities installed by the Electron sandbox preload. */
export interface ISandboxGlobals {
	readonly ipcRenderer: ISandboxIpcRenderer;
	readonly process: ISandboxProcess;
	readonly webUtils: ISandboxWebUtils;
}
