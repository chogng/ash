import "./media/sidebysideeditor.css";
import { h, type IDimension } from "../../../../base/browser/dom.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { EditorInput } from "./editorInput.js";
import { EditorPaneVisibility, type IEditorPane } from "./editorPane.js";

export interface SideBySideEditorInput extends EditorInput {
	readonly original: EditorInput;
	readonly modified: EditorInput;
}

/** Hosts two resource panes with independent lifetimes and a shared editor tab. */
export class SideBySideEditor extends Disposable implements IEditorPane {
	private container: HTMLElement | undefined;

	constructor(
		readonly id: string,
		private readonly secondaryPane: IEditorPane,
		private readonly primaryPane: IEditorPane,
	) {
		super();
		this._register(secondaryPane);
		this._register(primaryPane);
	}

	create(parent: HTMLElement): void {
		if (this.container) throw new ReferenceError("Side-by-side editor has already been created");
		const container = h(parent.ownerDocument, "div");
		container.className = "ash-side-by-side-editor";
		const left = h(parent.ownerDocument, "section");
		left.className = "ash-side-by-side-editor-secondary";
		left.setAttribute("aria-label", "Original");
		const right = h(parent.ownerDocument, "section");
		right.className = "ash-side-by-side-editor-primary";
		right.setAttribute("aria-label", "Modified");
		container.append(left, right);
		parent.append(container);
		this.container = container;
		this.secondaryPane.create(left);
		this.primaryPane.create(right);
		this._register(toDisposable(() => container.remove()));
	}

	async setInput(input: EditorInput, signal: AbortSignal): Promise<void> {
		if (!isSideBySideInput(input)) throw new TypeError("Side-by-side editor requires two inputs");
		if (!this.container) throw new ReferenceError("Side-by-side editor has not been created");
		throwIfCancelled(signal, "Side-by-side editor loading was cancelled");
		const results = await Promise.allSettled([
			this.secondaryPane.setInput(input.original, signal),
			this.primaryPane.setInput(input.modified, signal),
		]);
		const failure = results.find(result => result.status === "rejected");
		if (failure?.status === "rejected") {
			this.clearInput();
			throw failure.reason;
		}
		try {
			throwIfCancelled(signal, "Side-by-side editor loading was cancelled");
		} catch (error) {
			this.clearInput();
			throw error;
		}
	}

	clearInput(): void {
		this.secondaryPane.clearInput();
		this.primaryPane.clearInput();
	}

	layout(dimension: IDimension): void {
		const width = Math.max(0, dimension.width);
		const height = Math.max(0, dimension.height);
		const divider = 1;
		const leftWidth = Math.floor(Math.max(0, width - divider) / 2);
		this.secondaryPane.layout({ width: leftWidth, height });
		this.primaryPane.layout({ width: Math.max(0, width - divider - leftWidth), height });
	}

	setVisible(visibility: EditorPaneVisibility): void {
		if (this.container) this.container.hidden = visibility === EditorPaneVisibility.Hidden;
		this.secondaryPane.setVisible(visibility);
		this.primaryPane.setVisible(visibility);
	}

	focus(): void { this.primaryPane.focus(); }

	protected getSecondaryEditorPane(): IEditorPane { return this.secondaryPane; }
	protected getPrimaryEditorPane(): IEditorPane { return this.primaryPane; }
}

function isSideBySideInput(input: EditorInput): input is SideBySideEditorInput {
	return "original" in input && "modified" in input &&
		isEditorInput(input.original) && isEditorInput(input.modified);
}

function isEditorInput(value: unknown): value is EditorInput {
	return typeof value === "object" && value !== null && "resource" in value;
}
