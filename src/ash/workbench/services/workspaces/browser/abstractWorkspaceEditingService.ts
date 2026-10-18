import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IWorkspaceEditingService } from '../common/workspaceEditing.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';

/** Shared editing rules; runtime adapters submit operations to their host's single workspace owner. */
export abstract class AbstractWorkspaceEditingService extends Disposable implements IWorkspaceEditingService {
	constructor(
		@IWorkspaceContextService protected readonly workspace: IWorkspaceContextService,
		@IFileDialogService protected readonly dialogs: IFileDialogService,
		@IWorkingCopyService protected readonly workingCopies: IWorkingCopyService,
	) { super(); }

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

	async pickNewWorkspacePath(): Promise<URI | undefined> {
		const workspace = this.workspace.getWorkspace();
		const folder = workspace.folders[0]?.uri;
		const defaultUri = workspace.configuration?.scheme === 'file' ? workspace.configuration
			: folder?.scheme === 'file' ? URI.joinPath(folder.path.startsWith('/@browser/') ? folder : dirname(folder), 'workspace.ash-workspace')
				: URI.file('/workspace.ash-workspace');
		const resource = await this.dialogs.showSaveDialog({
			title: localize('workspace.saveAs', 'Save Workspace As...'),
			defaultUri,
			filters: [{ name: localize('workspace.fileType', 'Ash Workspace'), extensions: ['ash-workspace', 'code-workspace'] }],
		});
		if (!resource || workspace !== this.workspace.getWorkspace()) return undefined;
		return /\.(ash|code)-workspace$/i.test(resource.path) ? resource : resource.with({ path: `${resource.path}.ash-workspace` });
	}

	abstract updateFolders(index: number, deleteCount?: number, foldersToAdd?: readonly { readonly uri: URI; readonly name?: string; }[]): Promise<void>;
	abstract saveAndEnterWorkspace(path: URI): Promise<void>;

	protected ensureConfigurationSaved(): void {
		const configuration = this.workspace.getWorkspace().configuration;
		if (configuration && this.workingCopies.get(configuration).some(copy => copy.isDirty)) {
			throw new Error(localize('workspace.dirtyConfiguration', 'Save or revert unsaved changes to the workspace configuration file first.'));
		}
	}
}
