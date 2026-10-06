import type { IResourceEditorInput } from '../../../common/editor.js';
import { Emitter, type Event } from "../../../../base/common/event.js";
import type { TabListPresentation } from "../../../../base/browser/ui/tablist/tabList.js";
import { EditorTabsControl, type EditorTabDescriptor, type EditorTabsDelegate } from "./editorTabsControl.js";
import { MultiEditorTabsControl } from "./multiEditorTabsControl.js";
import type { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { StickyEditorGroupModel, UnstickyEditorGroupModel } from '../../../common/editor/filteredEditorGroupModel.js';
import type { ModernUIEditorTabStyle } from '../../../common/configuration.js';

import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";

/** Keeps sticky editors above ordinary editors while both rows share one group. */
export class MultiRowEditorControl extends EditorTabsControl {
	private readonly rowsEmitter = this._register(new Emitter<void>());
	readonly onDidChangeRows: Event<void> = this.rowsEmitter.event;
	private readonly stickyRow: MultiEditorTabsControl;
	private readonly ordinaryRow: MultiEditorTabsControl;
	private currentRows = 1;
	private presentation: TabListPresentation = 'inset';
	private tabStyle: ModernUIEditorTabStyle = 'connected';
	private readonly stickyModel: StickyEditorGroupModel;
	private readonly ordinaryModel: UnstickyEditorGroupModel;

	constructor(container: HTMLElement, delegate: EditorTabsDelegate, model: EditorGroupModel, @IInstantiationService instantiationService: IInstantiationService) {
		super(container);
		this.stickyModel = new StickyEditorGroupModel(model);
		this.ordinaryModel = new UnstickyEditorGroupModel(model);
		this.domNode.classList.add("ash-multi-row-editor-tabs-control");
		this.stickyRow = this._register(instantiationService.createInstance(MultiEditorTabsControl, this.domNode, delegate, model));
		this.stickyRow.domNode.classList.add("ash-sticky-editor-tabs-row");
		this.ordinaryRow = this._register(instantiationService.createInstance(MultiEditorTabsControl, this.domNode, delegate, model));
		this.ordinaryRow.domNode.classList.add("ash-ordinary-editor-tabs-row");
		this.stickyRow.domNode.hidden = true;
		this.ordinaryRow.domNode.hidden = true;
	}

	get rowCount(): number {
		return this.currentRows;
	}

	setEditors(editors: readonly EditorTabDescriptor[], activeInput: IResourceEditorInput | undefined, selectedIds?: ReadonlySet<string>): void {
		const descriptors = new Map(editors.map(editor => [editor.input, editor]));
		const sticky = this.stickyModel.getEditors().map(input => descriptors.get(input)!);
		const ordinary = this.ordinaryModel.getEditors().map(input => descriptors.get(input)!);
		this.stickyRow.setEditors(sticky, activeInput, selectedIds);
		this.ordinaryRow.setEditors(ordinary, activeInput, selectedIds);
		this.stickyRow.domNode.hidden = sticky.length === 0;
		this.ordinaryRow.domNode.hidden = ordinary.length === 0;
		const rows = sticky.length > 0 && ordinary.length > 0 ? 2 : 1;
		if (rows !== this.currentRows) {
			this.currentRows = rows;
			this.updatePresentation();
			this.rowsEmitter.fire();
		}
	}

	setPresentation(presentation: TabListPresentation, tabStyle: ModernUIEditorTabStyle): void {
		this.presentation = presentation;
		this.tabStyle = tabStyle;
		this.updatePresentation();
	}

	private updatePresentation(): void {
		// Only the row touching the editor can share its surface.
		this.stickyRow.setPresentation(this.presentation, this.currentRows === 2 ? 'pill' : this.tabStyle);
		this.ordinaryRow.setPresentation(this.presentation, this.tabStyle);
	}
}
