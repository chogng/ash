import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import "./media/sidebysideeditor.css";
import { h, type IDimension } from "../../../../base/browser/dom.js";
import { throwIfCancelled } from "../../../../base/common/cancellation.js";
import { toDisposable } from "../../../../base/common/lifecycle.js";
import { EditorPane } from './editorPane.js';
import { isResourceDiffEditorInput, type IResourceEditorInput, type IEditorPane } from '../../../common/editor.js';

/** Hosts two resource panes with independent lifetimes and a shared editor tab. */
export class SideBySideEditor extends EditorPane implements IEditorPane {
	private container: HTMLElement | undefined;

	constructor(
		readonly id: string,
		private readonly secondaryPane: EditorPane,
		private readonly primaryPane: EditorPane,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
	) {
		super(id, themeService, storageService);
		this._register(secondaryPane);
		this._register(primaryPane);
	}

	public override create(parent: HTMLElement): void {
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
		super.create(container);
		this.container = container;
		this.secondaryPane.create(left);
		this.primaryPane.create(right);
		this._register(toDisposable(() => container.remove()));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		if (!isResourceDiffEditorInput(input)) throw new TypeError("Side-by-side editor requires two inputs");
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

	public override clearInput(): void {
		this.secondaryPane.clearInput();
		this.primaryPane.clearInput();
	}

	public override layout(dimension: IDimension): void {
		const width = Math.max(0, dimension.width);
		const height = Math.max(0, dimension.height);
		const divider = 1;
		const leftWidth = Math.floor(Math.max(0, width - divider) / 2);
		this.secondaryPane.layout({ width: leftWidth, height });
		this.primaryPane.layout({ width: Math.max(0, width - divider - leftWidth), height });
	}

	public override setVisible(visibility: boolean): void {
		super.setVisible(visibility);
		this.secondaryPane.setVisible(visibility);
		this.primaryPane.setVisible(visibility);
	}

	public override focus(): void { this.primaryPane.focus(); }

	protected getSecondaryEditorPane(): IEditorPane { return this.secondaryPane; }
	protected getPrimaryEditorPane(): IEditorPane { return this.primaryPane; }
}
