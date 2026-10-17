import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { IWorkspaceContextApi, WorkspaceEditRequest } from '../../../../platform/workspace/common/workspaceIpc.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IWorkspaceEditingService } from '../common/workspaceEditing.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';

/** The host publishes accepted edits; the renderer never invents a folder list. */
export class WorkspaceEditingService implements IWorkspaceEditingService {
	constructor(
		private readonly host: IWorkspaceContextApi,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IFileDialogService private readonly dialogs: IFileDialogService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
	) { }

	validateFolders(folders: readonly URI[]): void {
		for (const copy of this.workingCopies.getAll()) {
			if (!copy.isDirty) continue;
			const current = this.workspace.getWorkspaceFolder(copy.resource);
			const next = folders.filter(folder => extUriBiasedIgnorePathCase.isEqualOrParent(copy.resource, folder)).sort((a, b) => b.path.length - a.path.length)[0];
			// A containing parent is not an equivalent execution/permission owner.
			// Adding a nested root can change ownership just as removing one can.
			if (current && (!next || !extUriBiasedIgnorePathCase.isEqual(current.uri, next))) {
				throw new Error(localize('workspace.dirtyRemovedFolder', 'Save or revert unsaved files before changing their workspace folder.'));
			}
		}
	}

	addFolders(folders: readonly { readonly uri: URI; readonly name?: string; }[]): Promise<void> {
		return this.updateFolders(this.workspace.getWorkspace().folders.length, 0, folders);
	}

	async removeFolders(folders: readonly URI[]): Promise<void> {
		const workspace = this.workspace.getWorkspace();
		const retained = workspace.folders.filter(folder => !folders.some(uri => uri.toString() === folder.uri.toString()));
		await this.updateFolders(0, workspace.folders.length, retained);
	}

	updateFolders(index: number, deleteCount = 0, foldersToAdd: readonly { readonly uri: URI; readonly name?: string; }[] = []): Promise<void> {
		return this.edit({ operation: 'folders', index, deleteCount, folders: foldersToAdd.map(folder => ({ uri: folder.uri.toString(), ...(folder.name === undefined ? {} : { name: folder.name }) })) });
	}

	saveAndEnterWorkspace(path: URI): Promise<void> {
		return this.edit({ operation: 'save', path: path.fsPath });
	}

	async pickNewWorkspacePath(): Promise<URI | undefined> {
		const workspace = this.workspace.getWorkspace();
		const resource = await this.dialogs.showSaveDialog({
			title: localize('workspace.saveAs', 'Save Workspace As...'),
			defaultUri: workspace.configuration ?? (workspace.folders[0] && URI.joinPath(dirname(workspace.folders[0].uri), 'workspace.ash-workspace')),
			filters: [{ name: localize('workspace.fileType', 'Ash Workspace'), extensions: ['ash-workspace', 'code-workspace'] }],
		});
		if (!resource) return undefined;
		return /\.(ash|code)-workspace$/i.test(resource.path) ? resource : resource.with({ path: `${resource.path}.ash-workspace` });
	}

	private async edit(request: WorkspaceEditRequest): Promise<void> {
		if (!this.host.editWorkspace) throw new Error(localize('workspace.editUnavailable', 'Workspace editing is unavailable in this host.'));
		const configuration = this.workspace.getWorkspace().configuration;
		if (configuration && this.workingCopies.get(configuration).some(copy => copy.isDirty)) {
			throw new Error(localize('workspace.dirtyConfiguration', 'Save or revert unsaved changes to the workspace configuration file first.'));
		}
		await this.host.editWorkspace(request);
	}
}
