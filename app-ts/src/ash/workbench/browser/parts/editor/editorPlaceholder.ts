import "./media/editorplaceholder.css";
import { h, type IDimension } from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { localize } from "../../../../nls.js";
import type { EditorInput } from "./editorInput.js";
import { EditorPaneVisibility, type IEditorPane } from "./editorPane.js";

/** Displays an open failure while preserving retry and close actions in the editor group. */
export class ErrorPlaceholderEditor extends Disposable implements IEditorPane {
	readonly id = "workbench.editor.openError";
	private root!: HTMLDivElement;
	private title!: HTMLHeadingElement;
	private detail!: HTMLParagraphElement;
	private retryButton!: Button;
	private input: EditorInput | undefined;

	constructor(
		private error: unknown,
		private readonly onRetry: () => void,
		private readonly onClose: () => void,
		private readonly alternative?: { readonly label: string; readonly run: () => void },
	) {
		super();
	}

	create(parent: HTMLElement): void {
		const ownerDocument = parent.ownerDocument;
		this.root = h(ownerDocument, "div");
		this.root.className = "ash-editor-open-error";
		this.root.tabIndex = -1;
		this.root.setAttribute("role", "alert");
		this.title = h(ownerDocument, "h2");
		this.detail = h(ownerDocument, "p");
		this.detail.className = "ash-editor-open-error-detail";
		const actions = h(ownerDocument, "div");
		actions.className = "ash-editor-open-error-actions";
		this.retryButton = this._register(new Button(actions, {
			label: localize("workbench.editorOpenRetry", "Retry"),
			presentation: "primary",
			onClick: this.onRetry,
		}));
		if (this.alternative) {
			this._register(new Button(actions, {
				label: this.alternative.label,
				presentation: "secondary",
				onClick: this.alternative.run,
			}));
		}
		this._register(new Button(actions, {
			label: localize("workbench.editorOpenClose", "Close Editor"),
			presentation: "secondary",
			onClick: this.onClose,
		}));
		this.root.append(this.title, this.detail, actions);
		parent.append(this.root);
		this._register(toDisposable(() => this.root.remove()));
		this.render();
	}

	setInput(input: EditorInput, _signal: AbortSignal): Promise<void> {
		this.input = input;
		this.render();
		return Promise.resolve();
	}

	updateError(error: unknown): void {
		this.error = error;
		this.render();
	}

	clearInput(): void {
		this.input = undefined;
	}

	layout(_dimension: IDimension): void {}
	setVisible(_visibility: EditorPaneVisibility): void {}

	focus(): void {
		this.retryButton?.focus();
	}

	private render(): void {
		if (!this.root) return;
		this.title.textContent = this.input
			? localize("workbench.editorOpenFailure", "Unable to open {0}", editorInputLabel(this.input))
			: localize("workbench.editorOpenFailureGeneric", "Unable to open editor");
		this.detail.textContent = errorMessage(this.error);
	}
}

function editorInputLabel(input: Pick<EditorInput, "resource" | "label">): string {
	if (input.label?.trim()) return input.label;
	const path = decodeURIComponent(input.resource.path).replace(/\/+$/u, "");
	const separator = path.lastIndexOf("/");
	return path.slice(separator + 1) || input.resource.toString();
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	return typeof error === "string" && error.trim()
		? error.trim()
		: localize("workbench.editorOpenUnknownError", "An unknown error occurred while opening this editor.");
}
