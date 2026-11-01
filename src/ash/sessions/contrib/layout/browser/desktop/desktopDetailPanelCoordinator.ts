import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { DesktopMainEditorPart } from '../../../../browser/parts/desktopEditorPart.js';
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
		if (reveal && !(this.editor as DesktopMainEditorPart).filesDetailsOpen) await this.openFiles();
	}

	public async openFiles(): Promise<void> {
		await (this.editor as DesktopMainEditorPart).openFiles();
		this.layout.showPart('editor');
	}

}
