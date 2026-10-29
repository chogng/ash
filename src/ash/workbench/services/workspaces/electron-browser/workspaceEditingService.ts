import { AbstractWorkspaceEditingService } from '../browser/abstractWorkspaceEditingService.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextApi, WorkspaceEditRequest } from '../../../../platform/workspace/common/workspaceIpc.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { IHostService } from '../../host/browser/host.js';

/** The host publishes accepted edits; the renderer never invents a folder list. */
export class WorkspaceEditingService extends AbstractWorkspaceEditingService {
	constructor(
		private readonly host: IWorkspaceContextApi,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IFileDialogService dialogs: IFileDialogService,
		@IWorkingCopyService workingCopies: IWorkingCopyService,
		@IHostService hostService: IHostService,
	) {
		super(workspace, dialogs, workingCopies, hostService);
	}

	updateFolders(
		index: number,
		deleteCount = 0,
		foldersToAdd: readonly { readonly uri: URI; readonly name?: string }[] = [],
	): Promise<void> {
		return this.edit({
			operation: 'folders',
			index,
			deleteCount,
			folders: foldersToAdd.map(folder => ({
				uri: folder.uri.toString(),
				...(folder.name === undefined ? {} : { name: folder.name }),
			})),
		});
	}

	saveAndEnterWorkspace(path: URI): Promise<void> {
		return this.edit({ operation: 'save', path: path.fsPath });
	}

	private async edit(request: WorkspaceEditRequest): Promise<void> {
		if (!this.host.editWorkspace)
			throw new Error(localize('workspace.editUnavailable', 'Workspace editing is unavailable in this host.'));
		this.ensureConfigurationSaved();
		await this.host.editWorkspace(request);
	}
}
