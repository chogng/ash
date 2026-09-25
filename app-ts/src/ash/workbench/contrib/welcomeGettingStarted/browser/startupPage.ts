import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createGettingStartedInput } from './gettingStartedInput.js';

export class StartupPageRunnerContribution extends Disposable {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceContext: IWorkspaceContextService,
	) {
		super();
		this._register(workspaceContext.onDidChangeWorkspace(() => this.openInEmptyWorkbench()));
		this.openInEmptyWorkbench();
	}

	private openInEmptyWorkbench(): void {
		if (this.workspaceContext.getWorkbenchState() !== WorkbenchState.EMPTY) return;
		if (this.editorService.visibleEditors.length > 0) return;
		void this.editorService.openEditor(createGettingStartedInput()).catch(error => console.error('Could not open Welcome', error));
	}
}
