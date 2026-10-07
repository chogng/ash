import { URI } from '../../base/common/uri.js';
import { DisposableStore } from '../../base/common/lifecycle.js';
import { localize } from '../../nls.js';
import type { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { getRemoteAuthority, getRemoteWorkspacePath, isRemoteResource } from '../../platform/remote/common/remote.js';
import type { IWorkspace } from '../../platform/workspace/common/workspace.js';
import type { SessionExecutionTarget, SessionWorkspaceSelection } from '../services/sessions/common/session.js';

export function selectionFromWorkspace(workspace: IWorkspace): SessionWorkspaceSelection {
	if (workspace.folders.length === 0) return { type: 'current' };
	const folders = workspace.folders.map(folder => ({ label: folder.name, target: selectionFromResource(folder.uri) }));
	if (folders.length > 1) return { type: 'multiple', folders };
	return folders[0]!.target;
}

function selectionFromResource(resource: URI): SessionExecutionTarget {
	if (!isRemoteResource(resource)) return { type: 'local', root: resource.fsPath };
	const authority = getRemoteAuthority(resource);
	if (!authority) throw new Error('Remote workspace has no SSH authority');
	return { type: 'ssh', host: authority.host, root: getRemoteWorkspacePath(resource) };
}

export function pickWorkspaceFolder(quickInput: IQuickInputService, folders: readonly { readonly label: string; readonly target: SessionExecutionTarget; }[]): Promise<SessionExecutionTarget | undefined> {
	const picker = quickInput.createQuickPick<{ label: string; description: string; target: SessionExecutionTarget; }>();
	picker.items = folders.map(folder => ({ label: folder.label, description: folder.target.type === 'ssh' ? `${folder.target.host}:${folder.target.root}` : folder.target.root, target: folder.target }));
	picker.placeholder = localize('sessions.selectExecutionFolder', 'Select a folder for this session');
	picker.ariaLabel = picker.placeholder;
	const disposables = new DisposableStore();
	disposables.add(picker);
	return new Promise(resolve => {
		let settled = false;
		const finish = (target: SessionExecutionTarget | undefined): void => {
			if (settled) return;
			settled = true;
			resolve(target);
			disposables.dispose();
		};
		disposables.add(picker.onDidAccept(item => finish(item.target)));
		disposables.add(picker.onDidHide(() => finish(undefined)));
		picker.show();
	});
}
