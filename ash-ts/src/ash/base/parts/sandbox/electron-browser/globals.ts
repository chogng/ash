import type { ISandboxGlobals } from "./sandboxTypes.js";

interface ISandboxGlobal {
	readonly ash?: ISandboxGlobals;
}

const globals = (globalThis as unknown as ISandboxGlobal).ash;
if (!globals) {
	throw new Error("Ash sandbox preload bridge is unavailable");
}

/** IPC capability installed by the sandbox preload. */
export const ipcRenderer = globals.ipcRenderer;

/** Read-only process metadata installed by the sandbox preload. */
export const sandboxProcess = globals.process;

/** Browser-object helpers installed by the sandbox preload. */
export const sandboxWebUtils = globals.webUtils;
