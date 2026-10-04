import "./media/singleeditortabscontrol.css";
import type { EditorInput } from "./editorInput.js";
import type { EditorTabDescriptor, EditorTabsDelegate } from "./editorTabsControl.js";
import { editorInputKey } from "./editorTabsControl.js";
import { MultiEditorTabsControl } from "./multiEditorTabsControl.js";

import { IResourceLabelService } from "../../labels.js";
import { IContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { IConfigurationService } from "../../../../platform/configuration/common/configuration.js";
import type { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { ILabelService } from '../../../../platform/label/common/labelService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

/** Presents only the active editor while retaining the normal tab interactions. */
export class SingleEditorTabsControl extends MultiEditorTabsControl {
	constructor(
		container: HTMLElement,
		delegate: EditorTabsDelegate,
		model: EditorGroupModel,
		@IResourceLabelService resourceLabels: IResourceLabelService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILabelService labelService: ILabelService,
		@IWorkspaceContextService workspaceContextService: IWorkspaceContextService,
	) {
		super(container, delegate, model, resourceLabels, configurationService, contextKeyService, labelService, workspaceContextService);
		this.domNode.classList.add("ash-single-editor-tabs-control");
	}

	override setEditors(editors: readonly EditorTabDescriptor[], activeInput: EditorInput | undefined, selectedIds?: ReadonlySet<string>): void {
		const active = activeInput
			? editors.find(editor => editorInputKey(editor.input) === editorInputKey(activeInput))
			: undefined;
		super.setEditors(active ? [active] : [], activeInput, selectedIds);
	}
}
