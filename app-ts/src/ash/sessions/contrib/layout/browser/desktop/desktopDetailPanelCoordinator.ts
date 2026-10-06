import { IViewsService } from '../../../../../workbench/services/views/common/viewsService.js';
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
		@IViewsService private readonly views: IViewsService,
		@IEditorService private readonly editors: IEditorService,
		@ILayoutService private readonly layout: IAgentWorkbenchLayoutService,
	) {}

	public get supportsActiveEditor(): boolean {
		const input = this.editors.activeEditor;
		return input !== undefined && (['ash-session-changes', 'file', 'ash-remote', 'untitled', 'ash-sessions-files'].includes(input.resource.scheme) || isDiffEditorInput(input) || isMultiDiffEditorInput(input));
	}

	public async update(reveal: boolean): Promise<void> {
		const input = this.editors.activeEditor;
		const changes = input && (input.resource.scheme === 'ash-session-changes' || isDiffEditorInput(input) || isMultiDiffEditorInput(input));
		const files = input && ['file', 'ash-remote', 'untitled', 'ash-sessions-files'].includes(input.resource.scheme);
		if (!changes && !files && this.layout.isPartVisible('editor')) {
			this.layout.hidePart('auxiliarybar');
			return;
		}
		// Hidden detail content is selected when explicitly opened; background updates must not resize the session grid.
		if (!reveal && !this.layout.isPartVisible('auxiliarybar')) { return; }
		await this.views.openViewContainer(changes ? CHANGES_VIEW_CONTAINER_ID : SESSIONS_FILES_CONTAINER_ID);
	}
}
