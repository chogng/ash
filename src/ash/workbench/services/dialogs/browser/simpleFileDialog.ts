import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	getWorkspaceRemoteAuthority,
	IWorkspaceContextService,
} from '../../../../platform/workspace/common/workspace.js';
import { createSshRemoteWorkspaceUri, getRemoteWorkspacePath } from '../../../../platform/remote/common/remote.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import type { IOpenDialogOptions } from '../../../../platform/dialogs/common/dialogs.js';

/** Selects an absolute remote directory; App Server validates existence after explicit authorization. */
export class SimpleFileDialog {
	constructor(
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
	) {}

	async showOpenDialog(options: IOpenDialogOptions): Promise<readonly URI[] | undefined> {
		const current = this.workspace.getWorkspace();
		const authority = getWorkspaceRemoteAuthority(current);
		if (!authority?.startsWith('ssh+')) throw new Error('Remote folder selection requires an SSH window');
		const parse = (path: string) => createSshRemoteWorkspaceUri(authority.slice(4), path);
		const value = await this.quickInput.input({
			title: options.title ?? localize('dialog.openFolder', 'Open Folder'),
			placeHolder: localize(
				'dialog.remoteFolderPath',
				'Enter an absolute folder path on the current remote host.',
			),
			value:
				options.defaultUri?.scheme === 'ash-remote'
					? getRemoteWorkspacePath(options.defaultUri)
					: current.folders[0]
						? getRemoteWorkspacePath(current.folders[0].uri)
						: '/',
			validateInput: async path => {
				try {
					parse(path);
					return undefined;
				} catch {
					return localize(
						'dialog.remoteFolderPath',
						'Enter an absolute folder path on the current remote host.',
					);
				}
			},
		});
		if (value === undefined || current !== this.workspace.getWorkspace()) return undefined;
		return [parse(value)];
	}
}
