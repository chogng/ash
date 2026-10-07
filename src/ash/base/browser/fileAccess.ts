import {
	DisposableStore,
	type IDisposable,
	toDisposable,
} from "../common/lifecycle.js";
import { addDisposableListener, h } from "./dom.js";
import type { BrowserWindow } from "./window.js";

export type FileSelection = "single" | "multiple";

export interface FilePickerOptions {
	readonly ownerDocument: Document;
	readonly accept?: readonly string[];
	readonly selection?: FileSelection;
	readonly directory?: boolean;
	readonly signal?: AbortSignal;
}

/** Opens a native browser file picker and resolves undefined when cancelled. */
export function pickFiles(
	options: FilePickerOptions,
): Promise<readonly File[] | undefined> {
	const ownerDocument = options.ownerDocument;
	requireOwnerWindow(ownerDocument);
	const input = h(ownerDocument, "input");
	input.type = "file";
	input.hidden = true;
	input.multiple = options.selection === "multiple";
	input.accept = options.accept?.join(",") ?? "";
	if (options.directory) input.setAttribute("webkitdirectory", "");
	ownerDocument.body.append(input);

	return new Promise((resolve) => {
		const registrations = new DisposableStore();
		let settled = false;
		const finish = (files: readonly File[] | undefined): void => {
			if (settled) return;
			settled = true;
			try {
				resolve(files);
			} finally {
				registrations.dispose();
				input.remove();
			}
		};

		registrations.add(addDisposableListener(input, "change", () =>
			finish(input.files ? [...input.files] : undefined),
		));
		registrations.add(addDisposableListener(input, "cancel", () =>
			finish(undefined),
		));

		const signal = options.signal;
		if (signal?.aborted) {
			finish(undefined);
			return;
		}
		if (signal) {
			const onAbort = (): void => finish(undefined);
			signal.addEventListener("abort", onAbort, { once: true });
			registrations.add(toDisposable(() =>
				signal.removeEventListener("abort", onAbort),
			));
		}

		input.click();
	});
}

/** Downloads a Blob or existing URL under an explicit filename. */
export function triggerDownload(
	source: Blob | URL,
	name: string,
	ownerDocument: Document,
): void {
	const targetWindow = requireOwnerWindow(ownerDocument);
	const objectUrl = isBlob(source)
		? targetWindow.URL.createObjectURL(source)
		: undefined;
	const link = h(ownerDocument, "a");
	link.download = name;
	link.href = objectUrl ?? source.toString();
	link.rel = "noopener";
	link.style.display = "none";
	ownerDocument.body.append(link);
	link.click();
	link.remove();
	if (objectUrl) {
		targetWindow.setTimeout(() => targetWindow.URL.revokeObjectURL(objectUrl), 0);
	}
}

/** Creates a temporary object URL with an explicit disposable lifetime. */
export function createObjectUrl(ownerWindow: Window, blob: Blob): {
	readonly url: URL;
	readonly registration: IDisposable;
} {
	const urlApi = (ownerWindow as BrowserWindow).URL;
	const value = urlApi.createObjectURL(blob);
	return {
		url: new urlApi(value),
		registration: toDisposable(() => urlApi.revokeObjectURL(value)),
	};
}

function requireOwnerWindow(ownerDocument: Document): BrowserWindow {
	const ownerWindow = ownerDocument.defaultView;
	if (!ownerWindow) throw new Error("Browser file access requires an owner window");
	return ownerWindow as BrowserWindow;
}

function isBlob(value: Blob | URL): value is Blob {
	return typeof (value as Blob).arrayBuffer === "function" &&
		typeof (value as Blob).stream === "function";
}
