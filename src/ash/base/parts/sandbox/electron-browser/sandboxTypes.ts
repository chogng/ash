import type { ISandboxIpcMessagePort, ISandboxIpcRenderer, ISandboxProcess } from "../common/sandboxTypes.js";
import type { WebUtils } from "./electronTypes.js";

/** Capabilities installed by the Electron sandbox preload. */
export interface ISandboxGlobals {
	readonly ipcRenderer: ISandboxIpcRenderer;
	readonly ipcMessagePort: ISandboxIpcMessagePort;
	readonly process: ISandboxProcess;
	readonly webUtils: WebUtils;
}
