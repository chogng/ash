import { string } from "../../ipc/electron-main/ipcValidation.js";

/** Validates an untrusted workspace-root-relative path before crossing IPC. */
export function relativeWorkspacePath(value: unknown): string {
	const path = string(value, "path");
	if (path.includes("\0") || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path) || path.split(/[\\/]/).includes("..")) {
		throw new Error("path must be relative to the workspace root");
	}
	return path;
}
