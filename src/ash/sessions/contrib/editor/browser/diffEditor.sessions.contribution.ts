import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { registerDiffEditorCommands } from '../../../../workbench/browser/parts/editor/diffEditorCommands.js';
import { DiffEditorCommandsService, type DiffEditorViewMode } from '../../../../workbench/browser/parts/editor/diffEditorCommandsService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { DIFF_EDITOR_ID } from '../../../../workbench/common/editor/diffEditorInput.js';
import { MULTI_DIFF_EDITOR_ID } from '../../../../workbench/contrib/multiDiffEditor/browser/multiDiffEditorInput.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { SESSIONS_DIFF_VIEW_MODE } from '../../../common/configuration.js';
import { SessionChangesEditor } from '../../changes/browser/sessionChangesEditor.js';

// The Agents renderer starts independently of the Workbench editor contribution.
registerDiffEditorCommands();

/** Diff commands change the Agents Window preference through its configuration owner. */
export class SessionsDiffEditorCommandsService extends DiffEditorCommandsService {
	constructor(
		@IEditorPart private readonly sessionsEditors: IEditorPart,
		@IEditorService editors: IEditorService,
		@IConfigurationService private readonly sessionsConfiguration: IConfigurationService,
	) {
		super(sessionsEditors, editors, sessionsConfiguration);
	}

	public override async toggleRenderSideBySide(): Promise<void> {
		await this.setViewMode(this.sessionsConfiguration.getValue<boolean>('diffEditor.renderSideBySide') ? 'inline' : 'automatic');
	}

	public override async setViewMode(mode: DiffEditorViewMode): Promise<void> {
		// A multi-file comparison may have no mounted diff control when its sections are collapsed.
		switch (this.sessionsEditors.activePane?.id) {
			case DIFF_EDITOR_ID:
			case MULTI_DIFF_EDITOR_ID:
			case SessionChangesEditor.ID:
				await this.sessionsConfiguration.updateValue(SESSIONS_DIFF_VIEW_MODE, mode);
				break;
		}
	}
}
