import { DiffEditorWidget } from '../../../../editor/browser/widget/diffEditor/diffEditorWidget.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { DiffEditorCommandsService, type DiffEditorViewMode } from '../../../../workbench/browser/parts/editor/diffEditorCommandsService.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { SESSIONS_DIFF_VIEW_MODE } from '../../../common/configuration.js';

/** Diff commands change the Agents Window preference through its configuration owner. */
export class SessionsDiffEditorCommandsService extends DiffEditorCommandsService {
	constructor(
		@IEditorPart private readonly sessionsEditors: IEditorPart,
		@IEditorService editors: IEditorService,
		@IConfigurationService private readonly sessionsConfiguration: IConfigurationService,
	) {
		super(sessionsEditors, editors, sessionsConfiguration);
	}

	override async toggleRenderSideBySide(): Promise<void> {
		await this.setViewMode(this.sessionsConfiguration.getValue<boolean>('diffEditor.renderSideBySide') ? 'inline' : 'sideBySide');
	}

	override async setViewMode(mode: DiffEditorViewMode): Promise<void> {
		if (!(this.sessionsEditors.activePane?.getControl?.() instanceof DiffEditorWidget)) return;
		await this.sessionsConfiguration.updateValue(SESSIONS_DIFF_VIEW_MODE, mode);
	}
}
