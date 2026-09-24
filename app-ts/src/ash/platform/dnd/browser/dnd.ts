import type { ISandboxGlobals } from "../../../base/parts/sandbox/electron-browser/sandboxTypes.js";

export const CodeDataTransfers = {
	EDITORS: "CodeEditors",
	FILES: "CodeFiles",
	SYMBOLS: "application/vnd.code.symbols",
	MARKERS: "application/vnd.code.diagnostics",
	NOTEBOOK_CELL_OUTPUT: "notebook-cell-output",
	SCM_HISTORY_ITEM: "scm-history-item",
	CHAT_REFERENCE: "application/vnd.code.chat-reference",
} as const;

/** Returns the desktop path associated with a browser File, when available. */
export function getPathForFile(file: File): string | undefined {
	const legacyPath = (file as File & { readonly path?: unknown }).path;
	if (typeof legacyPath === "string" && legacyPath.length > 0) return legacyPath;
	const globals = (globalThis as typeof globalThis & { readonly ash?: ISandboxGlobals }).ash;
	if (!globals?.webUtils) return undefined;
	const path = globals.webUtils.getPathForFile(file);
	return path.length > 0 ? path : undefined;
}

/**
 * Holds one typed drag payload while it remains inside the current renderer.
 *
 * Browser DataTransfer is still populated for native compatibility. This
 * transfer preserves the in-memory identity required by same-renderer drops
 * without serializing product objects into a browser-visible format.
 */
export class LocalSelectionTransfer<T> {
	private static readonly instance = new LocalSelectionTransfer<unknown>();

	private data: readonly T[] | undefined;
	private token: object | undefined;

	private constructor() {}

	static getInstance<T>(): LocalSelectionTransfer<T> {
		return LocalSelectionTransfer.instance as LocalSelectionTransfer<T>;
	}

	hasData(token: object): boolean {
		return token === this.token;
	}

	getData(token: object): readonly T[] | undefined {
		return this.hasData(token) ? this.data : undefined;
	}

	setData(data: readonly T[], token: object): void {
		this.data = [...data];
		this.token = token;
	}

	clearData(token: object): void {
		if (!this.hasData(token)) return;
		this.data = undefined;
		this.token = undefined;
	}
}
