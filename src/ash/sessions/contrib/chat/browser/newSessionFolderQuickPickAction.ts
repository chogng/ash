import { CancellationTokenSource, type CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import type { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { IProjectService } from '../../../../platform/projects/common/projectService.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspacesService } from '../../../../platform/workspaces/common/workspaces.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { LOCAL_AGENT_HOST_PROVIDER_ID } from '../../../common/agentHostSessionsProvider.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import { ISessionFolderAuthorizationService } from '../../../common/sessionWorkspace.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { projectForFolder, readCodeProjects } from './sessionWorkspaceProjects.js';

interface FolderPick extends IQuickPickItem {
	readonly folder?: URI;
}

const canStartSession = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ChatContextKeys.enabled.isEqualTo(true), SessionsWorkspaceModeContext.isEqualTo('code'));

function isLocalFolder(folder: URI): boolean {
	return folder.scheme === 'file' && !folder.authority && folder.path.startsWith('/') && !folder.query && !folder.fragment;
}

async function pickFolder(quickInput: IQuickInputService, items: FolderPick[], token: CancellationToken): Promise<FolderPick | undefined> {
	using resources = new DisposableStore();
	const picker = resources.add(quickInput.createQuickPick<FolderPick>());
	picker.placeholder = localize('sessions.newSession.pickFolderQuickPick.placeholder', 'Select a folder to start a new session in');
	picker.ariaLabel = picker.placeholder;
	picker.sortByLabel = false;
	picker.items = items;
	return await new Promise<FolderPick | undefined>(resolve => {
		resources.add(picker.onDidHide(() => resolve(undefined)));
		resources.add(picker.onDidAccept(() => {
			resolve(picker.selectedItems[0]);
			picker.hide();
		}));
		resources.add(token.onCancellationRequested(() => picker.hide()));
		picker.show();
	});
}

export class NewSessionFolderQuickPickAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.sessions.newSession.pickFolderQuickPick',
			title: localize2('sessions.newSession.pickFolderQuickPick.label', 'New Session in Folder…'),
			f1: true,
			precondition: canStartSession,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessions = accessor.get(ISessionsService);
		const quickInput = accessor.get(IQuickInputService);
		const workspaces = accessor.get(IWorkspacesService);
		const dialogs = accessor.get(IFileDialogService);
		const authorization = accessor.get(ISessionFolderAuthorizationService);
		const projects = accessor.get(IProjectService);
		const commands = accessor.get(ICommandService);
		const layout = accessor.get(ILayoutService);
		const contextKeys = accessor.get(IContextKeyService);
		if (!contextKeys.contextMatchesRules(canStartSession)) return;

		const revision = sessions.navigationRevision;
		using cancellation = new CancellationTokenSource();
		using navigation = sessions.onDidChange(() => {
			if (revision !== sessions.navigationRevision) cancellation.cancel();
		});
		using contextChanges = contextKeys.onDidChangeContext(event => {
			if (!contextKeys.contextMatchesRules(canStartSession)
				|| [...event.keys].some(key => key.startsWith('sessions.activity.') && key.endsWith('Selected'))) cancellation.cancel();
		});
		const signal = new AbortController();
		using cancelAuthorization = cancellation.token.onCancellationRequested(() => signal.abort());
		const recent = await workspaces.getRecentlyOpened();
		if (signal.signal.aborted) return;
		const picks: FolderPick[] = recent.workspaces.flatMap(entry => 'folderUri' in entry && isLocalFolder(entry.folderUri)
			? [{ folder: entry.folderUri, label: entry.label || basename(entry.folderUri) || entry.folderUri.fsPath, description: entry.folderUri.fsPath }]
			: []);
		picks.push({ label: localize('sessions.workspace.changeFolder', 'Open Folder…'), alwaysShow: true });
		const picked = await pickFolder(quickInput, picks, cancellation.token);
		if (!picked || signal.signal.aborted) return;
		const folder = picked.folder ?? (await dialogs.showOpenDialog({
			canSelectFiles: false, canSelectFolders: true, canSelectMany: false, availableFileSystems: ['file'],
		}))?.[0];
		if (!folder || !isLocalFolder(folder) || signal.signal.aborted) return;
		if (!await authorization.authorize([folder.fsPath], signal.signal) || signal.signal.aborted) return;
		const catalog = await readCodeProjects(projects);
		if (signal.signal.aborted) return;
		const project = await projectForFolder(projects, catalog, folder);
		if (signal.signal.aborted) return;
		sessions.openNewSession(undefined, { providerId: LOCAL_AGENT_HOST_PROVIDER_ID, workspace: { type: 'local', root: folder.fsPath }, projectId: project.id });
		await commands.executeCommand('sessions.open.code');
		layout.focus();
		await workspaces.addRecentlyOpened([{ folderUri: folder, label: picked.folder ? picked.label : basename(folder) || folder.fsPath }]);
	}
}
