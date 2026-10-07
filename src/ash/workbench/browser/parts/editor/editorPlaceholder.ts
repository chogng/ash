import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/editorplaceholder.css";
import { h, type IDimension } from "../../../../base/browser/dom.js";
import { Button } from "../../../../base/browser/ui/button/button.js";
import type { IAction } from "../../../../base/common/actions.js";
import { DisposableStore, toDisposable } from "../../../../base/common/lifecycle.js";
import { basename } from "../../../../base/common/resources.js";
import Severity from "../../../../base/common/severity.js";
import { localize } from "../../../../nls.js";
import { isEditorOpenError, type IResourceEditorInput, type IEditorPane } from '../../../common/editor.js';

import { EditorPane } from './editorPane.js';

let nextErrorPageId = 0;

/** Keeps an unsuccessful resource open with the actions supplied by its editor. */
export class ErrorPlaceholderEditor extends EditorPane implements IEditorPane {
	readonly id = "workbench.editor.openError";
	private root!: HTMLDivElement;
	private title!: HTMLHeadingElement;
	private detail!: HTMLParagraphElement;
	private severityLabel!: HTMLParagraphElement;
	private actionsDomNode!: HTMLDivElement;
	private readonly buttons = this._register(new DisposableStore());
	private firstButton: Button | undefined;
	private input: IResourceEditorInput | undefined;

	constructor(
		private error: unknown,
		private readonly onRetry: () => Promise<unknown>,
		private readonly onClose: () => Promise<unknown>,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super("workbench.editor.openError", themeService, storageService);
	}

	public override create(parent: HTMLElement): void {
		const ownerDocument = parent.ownerDocument;
		const id = ++nextErrorPageId;
		this.root = h(ownerDocument, "div");
		this.root.className = "ash-editor-open-error";
		this.root.tabIndex = -1;
		this.title = h(ownerDocument, "h2");
		this.title.id = `ash-editor-open-error-title-${id}`;
		this.detail = h(ownerDocument, "p");
		this.detail.id = `ash-editor-open-error-detail-${id}`;
		this.detail.className = "ash-editor-open-error-detail";
		this.root.setAttribute("aria-labelledby", this.title.id);
		this.root.setAttribute("aria-describedby", this.detail.id);
		this.severityLabel = h(ownerDocument, "p");
		this.severityLabel.className = "ash-editor-open-error-severity";
		this.actionsDomNode = h(ownerDocument, "div");
		this.actionsDomNode.className = "ash-editor-open-error-actions";
		this.root.append(this.severityLabel, this.title, this.detail, this.actionsDomNode);
		parent.append(this.root);
		super.create(this.root);
		this._register(toDisposable(() => this.root.remove()));
		this.render();
	}

	public override setInput(input: IResourceEditorInput, _signal: AbortSignal): Promise<void> {
		this.input = input;
		this.render();
		return Promise.resolve();
	}

	updateError(error: unknown): void {
		this.error = error;
		this.render();
	}

	public override clearInput(): void {
		this.input = undefined;
	}

	public override layout(_dimension: IDimension): void { }

	public override focus(): void {
		this.firstButton?.focus();
	}

	private render(): void {
		if (!this.root) return;
		const error = isEditorOpenError(this.error) ? this.error : undefined;
		const severity = error?.forceSeverity ?? Severity.Error;
		this.root.classList.toggle("warning", severity === Severity.Warning);
		this.root.classList.toggle("info", severity === Severity.Info);
		this.root.setAttribute("role", severity === Severity.Info ? "status" : "alert");
		this.severityLabel.textContent = severity === Severity.Warning
			? localize("workbench.editorOpenWarning", "Warning")
			: severity === Severity.Info
				? localize("workbench.editorOpenInfo", "Information")
				: localize("workbench.editorOpenError", "Error");
		this.title.textContent = error?.forceMessage ? error.message : this.input
			? localize("workbench.editorOpenFailure", "Unable to open {0}", this.input.label || basename(this.input.resource))
			: localize("workbench.editorOpenFailureGeneric", "Unable to open editor");
		this.detail.hidden = error?.forceMessage === true;
		this.detail.textContent = this.error instanceof Error ? this.error.message
			: localize("workbench.editorOpenUnknownError", "An unknown error occurred while opening this editor.");
		const actions: readonly IAction[] = error?.actions.length ? error.actions : [{
			id: "workbench.editor.retry",
			label: localize("workbench.editorOpenRetry", "Retry"),
			tooltip: "",
			enabled: true,
			run: this.onRetry,
		}];
		this.buttons.clear();
		this.firstButton = undefined;
		for (const action of actions) {
			const button: Button = this.buttons.add(new Button(this.actionsDomNode, {
				label: action.label,
				enabled: action.enabled,
				presentation: this.firstButton ? "secondary" : "primary",
				onClick: () => { void this.runAction(action, button); },
			}));
			if (!this.firstButton && action.enabled) this.firstButton = button;
		}
		this.buttons.add(new Button(this.actionsDomNode, {
			label: localize("workbench.editorOpenClose", "Close Editor"),
			presentation: "secondary",
			onClick: () => { void this.runAction({ id: "workbench.editor.close", label: "", tooltip: "", enabled: true, run: this.onClose }); },
		}));
	}

	private async runAction(action: IAction, button?: Button): Promise<void> {
		if (button) button.enabled = false;
		try {
			await action.run();
		} catch (error) {
			console.error("Editor open action failed", error);
			if (!this.isDisposed) {
				this.updateError(error);
				this.focus();
			}
		} finally {
			if (!this.isDisposed && button) button.enabled = action.enabled;
		}
	}
}
