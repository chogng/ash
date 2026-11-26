import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { EditorParts } from '../../../../browser/parts/editorParts.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import type { EditorReplacementTarget } from '../../../../../workbench/services/editor/common/editorService.js';

/** Opens the Files tab or reveals Details beside the active document. */
export class DesktopDetailPanelCoordinator {
	constructor(
		@IEditorPart private readonly editor: IEditorPart,
		@ILayoutService private readonly layout: IAgentWorkbenchLayoutService,
	) { }

	public get supportsActiveEditor(): boolean {
		return true;
	}

	public showDetails(): void {
		(this.editor as EditorParts).filesPart.showDetails();
		this.layout.showPart('editor');
	}

	public async openFiles(target?: EditorReplacementTarget): Promise<void> {
		await (this.editor as EditorParts).openFiles(target);
		this.layout.showPart('editor');
	}

}
