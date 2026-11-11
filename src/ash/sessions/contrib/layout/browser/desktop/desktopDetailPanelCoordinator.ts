import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { EditorParts } from '../../../../browser/parts/editorParts.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';

/** Tool selection is explicit; opening or closing a document never hides Files. */
export class DesktopDetailPanelCoordinator {
	constructor(
		@IEditorPart private readonly editor: IEditorPart,
		@ILayoutService private readonly layout: IAgentWorkbenchLayoutService,
	) { }

	public get supportsActiveEditor(): boolean {
		return true;
	}

	public async update(reveal: boolean): Promise<void> {
		if (reveal && !(this.editor as EditorParts).filesDetailsOpen) await this.openFiles();
	}

	public async openFiles(): Promise<void> {
		await (this.editor as EditorParts).openFiles();
		this.layout.showPart('editor');
	}

}
