import { Disposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createGettingStartedInput } from './gettingStartedInput.js';

export const StartupEditorConfigurationKey = 'workbench.startupEditor';
export type StartupEditor = 'none' | 'welcomePage' | 'welcomePageInEmptyWorkbench';

export class StartupPageRunnerContribution extends Disposable {
	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) {
		super();
		void this.openStartupEditor().catch(error => console.error('Could not open Welcome', error));
	}

	onWorkspaceRestored(): Promise<void> {
		return this.openStartupEditor();
	}

	private async openStartupEditor(): Promise<void> {
		const startupEditor = this.configurationService.getValue<StartupEditor>(StartupEditorConfigurationKey);
		if (startupEditor === 'none') return;
		if (startupEditor === 'welcomePageInEmptyWorkbench' && this.workspaceContext.getWorkbenchState() !== WorkbenchState.EMPTY) return;
		if (this.editorService.visibleEditors.length > 0) return;
		await this.editorService.openEditor(createGettingStartedInput());
	}
}
