import "./media/diffEditorBreadcrumbs.css";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { LineDiffKind, type LineDiffRow } from "../../../common/diff/lineDiff.js";
import { type DiffModel } from "../../../common/diff/diffModel.js";
import { type DiffEditorWidget } from "../../../browser/widget/diffEditor/diffEditorWidget.js";
import { h } from "../../../../base/browser/dom.js";

/** Adds compact changed-hunk navigation to the Stanza diff editor without touching diff computation. */
export class DiffEditorBreadcrumbsController extends Disposable {
	private readonly element: HTMLElement;

	constructor(private readonly editor: DiffEditorWidget, private readonly model: DiffModel) {
		super();
		const document = editor.element.ownerDocument;
		this.element = h(document, "nav");
		this.element.className = "stanza-diff-editor-breadcrumbs";
		this.element.setAttribute("aria-label", "Diff changes");
		editor.element.append(this.element);
		this._register(toDisposable(() => this.element.remove()));
		this._register(model.onDidChange(() => this.render()));
		this.render();
	}

	private render(): void {
		const rows = this.model.diff?.rows ?? [];
		this.element.replaceChildren(...rows.flatMap((row, index) => row.kind === LineDiffKind.Unchanged ? [] : [this.createItem(row, index)]));
		this.element.hidden = this.element.childElementCount === 0;
	}

	private createItem(row: LineDiffRow, rowIndex: number): HTMLButtonElement {
		const button = h(this.element.ownerDocument, "button");
		button.type = "button";
		button.className = "stanza-diff-editor-breadcrumb";
		button.textContent = `${row.modifiedLineIndex === undefined ? "—" : row.modifiedLineIndex + 1}`;
		button.title = `Reveal change ${rowIndex + 1}`;
		button.addEventListener("click", () => {
			if (row.modifiedLineIndex !== undefined) this.editor.revealModifiedLine(row.modifiedLineIndex);
			else if (row.originalLineIndex !== undefined) this.editor.revealOriginalLine(row.originalLineIndex);
		});
		return button;
	}
}
