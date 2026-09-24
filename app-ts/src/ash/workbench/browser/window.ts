import { cloneDocumentStyles } from "../../base/browser/domStylesheets.js";
import {
	isRegisteredWindow,
	mainWindow,
	registerWindow,
} from "../../base/browser/window.js";
import { onUnexpectedError } from "../../base/common/errors.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { environment } from "../../base/common/platform.js";
import { type WorkbenchState, workbenchStateToString } from '../../platform/workspace/common/workspace.js';
import type { WorkbenchModeId } from "../common/workbenchMode.js";
import { type IWorkbenchHostService, type WorkbenchTextDownload } from "../services/host/common/workbenchHostService.js";
import { h } from "../../base/browser/dom.js";

export interface WorkbenchWindowOptions {
	readonly root: HTMLElement;
	readonly modeId: WorkbenchModeId;
	readonly workbenchState: WorkbenchState;
}

/**
 * Owns the browser-window identity and document integration for one Workbench.
 *
 * Workbench services and Parts use `ownerDocument`; this class owns the
 * corresponding window registration, stylesheet projection, root attributes,
 * and deterministic teardown.
 */
export class WorkbenchWindow
	extends Disposable
	implements IWorkbenchHostService {
	readonly root: HTMLElement;
	readonly ownerDocument: Document;
	readonly targetWindow: Window | null;

	constructor(options: WorkbenchWindowOptions) {
		super();
		this.root = options.root;
		this.ownerDocument = options.root.ownerDocument;
		this.targetWindow = this.ownerDocument.defaultView;

		options.root.classList.add("ash-workbench");
		options.root.setAttribute("data-workbench-mode", options.modeId);
		options.root.setAttribute("data-runtime", environment.runtime);
		options.root.setAttribute("data-os", environment.os);
		this.setWorkbenchState(options.workbenchState);
		this._register(toDisposable(() => {
			options.root.classList.remove("ash-workbench");
			options.root.removeAttribute("data-workbench-mode");
			options.root.removeAttribute("data-runtime");
			options.root.removeAttribute("data-os");
			options.root.removeAttribute("data-workbench-state");
			options.root.replaceChildren();
		}));

		if (
			this.targetWindow &&
			!isRegisteredWindow(this.targetWindow)
		) {
			this._register(registerWindow(this.targetWindow));
		}
		if (this.ownerDocument !== mainWindow.document) {
			this._register(cloneDocumentStyles(
				mainWindow.document,
				this.ownerDocument,
			));
		}
		if (this.targetWindow) {
			const onError = (event: ErrorEvent): void => {
				const source = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : "";
				onUnexpectedError(event.error ?? new Error(`${event.message || "Unexpected browser error"}${source}`));
				event.preventDefault();
			};
			const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
				onUnexpectedError(event.reason);
				event.preventDefault();
			};
			this.targetWindow.addEventListener("error", onError);
			if (this.targetWindow !== mainWindow) this.targetWindow.addEventListener("unhandledrejection", onUnhandledRejection);
			this._register(toDisposable(() => {
				this.targetWindow?.removeEventListener("error", onError);
				if (this.targetWindow !== mainWindow) this.targetWindow?.removeEventListener("unhandledrejection", onUnhandledRejection);
			}));
		}
	}

	downloadText(download: WorkbenchTextDownload): void {
		if (!this.targetWindow) throw new Error("Text download requires a browser window");
		const targetWindow = this.targetWindow as Window & typeof globalThis;
		const url = targetWindow.URL.createObjectURL(new targetWindow.Blob([download.content], { type: download.mediaType }));
		const anchor = h(this.ownerDocument, "a");
		anchor.href = url;
		anchor.download = download.fileName;
		anchor.click();
		targetWindow.setTimeout(() => targetWindow.URL.revokeObjectURL(url), 0);
	}

	setWorkbenchState(state: WorkbenchState): void {
		this.root.setAttribute(
			"data-workbench-state",
			workbenchStateToString(state),
		);
	}
}
