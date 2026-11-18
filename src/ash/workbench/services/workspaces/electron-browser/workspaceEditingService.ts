import { AbstractWorkspaceEditingService } from '../browser/abstractWorkspaceEditingService.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorkspaceFolderLocationService } from '../../../../platform/workspace/common/folderLocations.js';
import { getWorkspacePrimaryFolderUri, IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextApi, WorkspaceEditRequest } from '../../../../platform/workspace/common/workspaceIpc.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { IHostService } from '../../host/browser/host.js';
import type { ISetFolderLocationOptions } from '../common/workspaceEditing.js';

/** The host publishes accepted edits; the renderer never invents a folder list. */
export class WorkspaceEditingService extends AbstractWorkspaceEditingService {
	private changingLocation = false;

	constructor(
		private readonly host: IWorkspaceContextApi,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IFileDialogService dialogs: IFileDialogService,
		@IWorkingCopyService workingCopies: IWorkingCopyService,
		@IHostService hostService: IHostService,
		@IWorkspaceFolderLocationService private readonly folderLocations: IWorkspaceFolderLocationService,
	) { super(workspace, dialogs, workingCopies, hostService); }

	updateFolders(index: number, deleteCount = 0, foldersToAdd: readonly { readonly uri: URI; readonly name?: string; }[] = []): Promise<void> {
		return this.edit({ operation: 'folders', index, deleteCount, folders: foldersToAdd.map(folder => ({ uri: folder.uri.toString(), ...(folder.name === undefined ? {} : { name: folder.name }) })) });
	}

	saveAndEnterWorkspace(path: URI): Promise<void> {
		return this.edit({ operation: 'save', path: path.fsPath });
	}

	override async setFolderLocation(location: URI, options?: ISetFolderLocationOptions): Promise<void> {
		this.assertNotDisposed();
		if (this.changingLocation) {
			if (options?.ifIdle) return;
			throw new CancellationError();
		}
		const workspace = this.workspace.getWorkspace();
		const folder = workspace.folders[0];
		const primary = getWorkspacePrimaryFolderUri(workspace);
		if (!folder || !primary || !this.folderLocations.canSetLocation(folder)) {
			throw new Error(localize('workspace.folderLocation.unavailable', 'Folder locations are unavailable in this workspace.'));
		}
		const equal = extUriBiasedIgnorePathCase.isEqual.bind(extUriBiasedIgnorePathCase);
		if (options?.folder && !equal(options.folder, folder.uri)) throw new CancellationError();
		if (equal(folder.uri, location)) return;

		this.changingLocation = true;
		using cancellation = new CancellationTokenSource();
		using workspaceChange = this.workspace.onDidChangeWorkspace(() => cancellation.cancel());
		try {
			const isPrimary = equal(primary, location);
			const alternate = isPrimary ? undefined : await this.folderLocations.resolveLocation(primary, location, cancellation.token);
			if (this.isDisposed || cancellation.token.isCancellationRequested) throw new CancellationError();
			if (!isPrimary && !alternate) {
				throw new Error(localize('workspace.folderLocation.unknown', 'The selected folder location is no longer available.'));
			}
			const target = alternate?.uri ?? primary;
			this.validateFolders([target]);
			await this.edit({
				operation: 'folderLocation',
				workspaceId: workspace.id,
				current: folder.uri.toString(),
				target: target.toString(),
				reason: options?.reason ?? 'programmatic',
				...(alternate ? {
					alternate: {
						label: alternate.label,
						providerId: alternate.providerId,
						builtIn: alternate.builtIn,
						...(alternate.description === undefined ? {} : { description: alternate.description }),
						...(alternate.group === undefined ? {} : { group: alternate.group }),
					},
				} : {}),
			});
		} finally {
			this.changingLocation = false;
		}
	}

	private async edit(request: WorkspaceEditRequest): Promise<void> {
		if (!this.host.editWorkspace) throw new Error(localize('workspace.editUnavailable', 'Workspace editing is unavailable in this host.'));
		this.ensureConfigurationSaved();
		await this.host.editWorkspace(request);
	}
}
