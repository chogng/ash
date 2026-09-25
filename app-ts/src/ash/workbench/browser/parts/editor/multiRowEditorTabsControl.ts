import { Emitter, type Event } from "../../../../base/common/event.js";
import type { TabListPresentation } from "../../../../base/browser/ui/tablist/tabList.js";
import type { EditorInput } from "./editorInput.js";
import { EditorTabsControl, type EditorTabDescriptor, type EditorTabsDelegate } from "./editorTabsControl.js";
import { MultiEditorTabsControl } from "./multiEditorTabsControl.js";

/** Keeps sticky editors above ordinary editors while both rows share one group. */
export class MultiRowEditorControl extends EditorTabsControl {
	private readonly rowsEmitter = this._register(new Emitter<void>());
	readonly onDidChangeRows: Event<void> = this.rowsEmitter.event;
	private readonly stickyRow: MultiEditorTabsControl;
	private readonly ordinaryRow: MultiEditorTabsControl;
	private currentRows = 1;

	constructor(container: HTMLElement, delegate: EditorTabsDelegate) {
		super(container);
		this.domNode.classList.add("ash-multi-row-editor-tabs-control");
		this.stickyRow = this._register(new MultiEditorTabsControl(this.domNode, delegate));
		this.stickyRow.domNode.classList.add("ash-sticky-editor-tabs-row");
		this.ordinaryRow = this._register(new MultiEditorTabsControl(this.domNode, delegate));
		this.ordinaryRow.domNode.classList.add("ash-ordinary-editor-tabs-row");
		this.stickyRow.domNode.hidden = true;
		this.ordinaryRow.domNode.hidden = true;
	}

	get rowCount(): number {
		return this.currentRows;
	}

	setEditors(editors: readonly EditorTabDescriptor[], activeInput: EditorInput | undefined, selectedIds?: ReadonlySet<string>): void {
		const sticky = editors.filter(editor => editor.sticky);
		const ordinary = editors.filter(editor => !editor.sticky);
		this.stickyRow.setEditors(sticky, activeInput, selectedIds);
		this.ordinaryRow.setEditors(ordinary, activeInput, selectedIds);
		this.stickyRow.domNode.hidden = sticky.length === 0;
		this.ordinaryRow.domNode.hidden = ordinary.length === 0;
		const rows = sticky.length > 0 && ordinary.length > 0 ? 2 : 1;
		if (rows !== this.currentRows) {
			this.currentRows = rows;
			this.rowsEmitter.fire();
		}
	}

	setPresentation(presentation: TabListPresentation): void {
		this.stickyRow.setPresentation(presentation);
		this.ordinaryRow.setPresentation(presentation);
	}
}
