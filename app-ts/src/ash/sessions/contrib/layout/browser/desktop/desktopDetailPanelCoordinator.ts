import type { AuxiliaryBarPart } from '../../../../browser/parts/auxiliarybar/auxiliaryBarPart.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { isDiffEditorInput } from '../../../../../workbench/common/editor/diffEditorInput.js';
import { isMultiDiffEditorInput } from '../../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import type { IAgentWorkbenchLayoutService } from '../../../../browser/workbench.js';
import { SESSIONS_FILES_CONTAINER_ID } from '../../../files/browser/files.contribution.js';
import { CHANGES_VIEW_CONTAINER_ID } from '../../../changes/browser/changes.contribution.js';

/** Active tabs choose detail content; an explicit hide remains authoritative until another tab is selected. */
export class DesktopDetailPanelCoordinator {
	constructor(
		private readonly details: AuxiliaryBarPart,
		@IEditorService private readonly editors: IEditorService,
		@ILayoutService private readonly layout: IAgentWorkbenchLayoutService,
	) {}

	public get supportsActiveEditor(): boolean {
		const input = this.editors.activeEditor;
		return input !== undefined && (['ash-session-changes', 'file', 'ash-remote', 'untitled', 'ash-sessions-files'].includes(input.resource.scheme) || isDiffEditorInput(input) || isMultiDiffEditorInput(input));
	}

	public update(reveal: boolean): void {
		const input = this.editors.activeEditor;
		const changes = input && (input.resource.scheme === 'ash-session-changes' || isDiffEditorInput(input) || isMultiDiffEditorInput(input));
		const files = input && ['file', 'ash-remote', 'untitled', 'ash-sessions-files'].includes(input.resource.scheme);
		if (!changes && !files && this.layout.isPartVisible('editor')) {
			this.layout.hidePart('auxiliarybar');
			return;
		}
		this.details.showComposite(changes ? CHANGES_VIEW_CONTAINER_ID : SESSIONS_FILES_CONTAINER_ID);
		if (reveal) {
			this.layout.showPart('auxiliarybar');
		}
	}
}
