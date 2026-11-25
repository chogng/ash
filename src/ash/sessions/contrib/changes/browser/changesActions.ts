import { SessionsEditorToolContext } from '../../../common/contextkeys.js';
import { Menus } from '../../../browser/menus.js';
import { getMultiDiffEditorFilesViewTitle, getToggleMultiDiffEditorFileListTitle, MultiDiffEditorFileIsBinaryContext, MultiDiffEditorFileListAvailableContext, MultiDiffEditorFileListEnabledContext, MultiDiffEditorFilesViewMenu, TOGGLE_MULTI_DIFF_EDITOR_FILE_LIST_COMMAND_ID } from '../../../../workbench/contrib/multiDiffEditor/common/multiDiffEditor.js';
import { DisposableStore, type IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerDiffEditorViewMenu } from '../../../../workbench/browser/parts/editor/diffEditorCommands.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import { ActiveEditorContext, SessionsCodeEditorContext } from '../../../../workbench/common/contextkeys.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { sessionWorkspaceUri } from '../../../common/sessionWorkspace.js';
import { SessionChangesetOperationStatus } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import { ChangesCanPreviewCommitContext, ChangesHasWorkspaceContext, ChangesScopeContext, SessionChangesEditor } from './sessionChangesEditor.js';
import { ISessionChangesService } from '../common/sessionChangesService.js';

registerDiffEditorViewMenu(ActiveEditorContext.isEqualTo(SessionChangesEditor.ID));

const captureFile = ContextKeyExpr.and(ActiveEditorContext.isEqualTo(SessionChangesEditor.ID), ContextKeyExpr.not('sessions.changesGitFile'));

class OpenChangedFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.openFile', title: localize2('sessions.changes.openFile', 'Open File'),
			icon: Lxicon.goToFile,
			menu: { id: MenuId.MultiDiffEditorFileToolbar, when: captureFile, group: 'navigation', order: 22 },
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const argument = args[0];
		const resource = argument instanceof URI ? argument : isRecord(argument) ? argument.resource : undefined;
		if (!(resource instanceof URI)) { return; }
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof SessionChangesEditor)) { return; }
		const change = await pane.getFileChange(resource);
		if (!change) { return; }
		const owner = 'summary' in change ? change.summary : change;
		const session = accessor.get(ISessionsManagementService).sessions.find(session => session.sessionId === owner.sessionId);
		const workspace = session?.chats.find(chat => chat.threadId === owner.threadId)?.workspace ?? session?.workspace;
		if (!workspace) { return; }
		const root = sessionWorkspaceUri(workspace);
		const fileResource = root.with({ path: `${root.path.replace(/\/$/u, '')}/${change.file.path}` });
		await accessor.get(IEditorService).openEditor({ resource: fileResource }, { pinned: true });
	}
}

registerAction2(OpenChangedFileAction);

async function setUnchangedRegions(accessor: ServicesAccessor, resource: unknown, enabled: boolean): Promise<void> {
	if (!(resource instanceof URI) && isRecord(resource)) { resource = resource.resource; }
	if (!(resource instanceof URI)) { return; }
	const pane = accessor.get(IEditorPart).activePane;
	if (!(pane instanceof SessionChangesEditor)) { return; }
	const change = await pane.getFileChange(resource);
	if (!change) { return; }
	// The shared comparison owns region folding; select the row receiving this action.
	pane.restoreViewState({ revealData: { resource: { original: change.originalUri, modified: change.modifiedUri } } });
	pane.getControl()?.updateOptions({ hideUnchangedRegions: { enabled } });
}

class ExpandFullFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.expandFullFile',
			title: localize2('sessions.changes.expandFullFile', 'Expand Full File'),
			icon: Lxicon.unfold,
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.and(captureFile, MultiDiffEditorFileIsBinaryContext.isEqualTo(false)),
				group: 'navigation', order: 23,
			},
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await setUnchangedRegions(accessor, args[0], false);
	}
}

class CollapseUnchangedRegionsAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.collapseUnchangedRegions',
			title: localize2('sessions.changes.collapseUnchanged', 'Collapse Unchanged Regions'),
			icon: Lxicon.fold,
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ContextKeyExpr.and(captureFile, MultiDiffEditorFileIsBinaryContext.isEqualTo(false)),
				group: 'navigation', order: 24,
			},
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		await setUnchangedRegions(accessor, args[0], true);
	}
}

registerAction2(ExpandFullFileAction);
registerAction2(CollapseUnchangedRegionsAction);

class PreviewChangesetFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.agentSessions.changes.previewFile',
			title: localize2('sessions.changes.previewCommit', 'Preview commit…'),
			icon: Lxicon.gitCommit,
			precondition: ContextKeyExpr.has('sessions.changesCanPreview'),
			menu: {
				id: MenuId.MultiDiffEditorFileToolbar,
				when: ActiveEditorContext.isEqualTo(SessionChangesEditor.ID),
				group: 'navigation', order: 30,
			},
		});
	}
	public async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const argument = args[0];
		const resource = argument instanceof URI ? argument : isRecord(argument) ? argument.resource : undefined;
		if (!(resource instanceof URI)) { return; }
		const pane = accessor.get(IEditorPart).activePane;
		if (!(pane instanceof SessionChangesEditor)) { return; }
		const change = await pane.getFileChange(resource);
		if (!change || !('summary' in change)) { return; }
		const sessionResource = URI.from({ scheme: 'ash-session', path: `/${change.summary.sessionId}`, query: new URLSearchParams({ thread: change.summary.threadId }).toString() });
		const changeset = await accessor.get(ISessionChangesService).resolveChangeset(sessionResource, change.summary.changeSetId);
		const operation = changeset.operations.get().find(operation => operation.id === 'preview');
		if (operation && operation.status !== SessionChangesetOperationStatus.Disabled && operation.status !== SessionChangesetOperationStatus.Running) {
			await changeset.invokeOperation(operation.id, { kind: 'resource', resource: change.uri });
		}
	}
}

registerAction2(PreviewChangesetFileAction);

/** Contributes actions for the Changes editor group in the Agent Window. */
export function registerChangesEditorTitleActions(editor: IEditorPart): IDisposable {
	const disposables = new DisposableStore();
	const getGroup = (arg: unknown) =>
		(isRecord(arg) ? editor.groups.find(group => group.id === arg.groupId) : undefined) ?? editor.activeGroup;
	const changesTool = ContextKeyExpr.and(SessionsCodeEditorContext.isEqualTo(true), SessionsEditorToolContext.isEqualTo('changes'));
	const previewCommitId = 'ash.sessions.changes.previewCommit';
	disposables.add(CommandsRegistry.register(previewCommitId, (_accessor, arg) => {
		const pane = getGroup(arg)?.activePane;
		return pane instanceof SessionChangesEditor ? pane.previewCommit() : undefined;
	}));
	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
		command: { id: previewCommitId, title: localize2('sessions.changes.previewCommit', 'Preview commit…') },
		when: ContextKeyExpr.and(changesTool, ChangesHasWorkspaceContext.isEqualTo(true), ChangesCanPreviewCommitContext.isEqualTo(true),
			ContextKeyExpr.or(ChangesScopeContext.isEqualTo('all'), ChangesScopeContext.isEqualTo('turn'))),
		group: '1_changes', order: 0,
	}));
	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
		submenu: MultiDiffEditorFilesViewMenu, title: getMultiDiffEditorFilesViewTitle(),
		when: ContextKeyExpr.and(changesTool, MultiDiffEditorFileListAvailableContext.isEqualTo(true)), group: '1_changes', order: 1,
	}));
	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorHeaderPrimary, {
		submenu: Menus.SessionsChangesScope, title: localize2('sessions.changes.title', 'Changes'),
		when: changesTool, group: 'navigation',
	}));
	for (const [order, [scope, title]] of ([
		['all', localize2('sessions.changes.allChanges', 'All Changes')],
		['turn', localize2('sessions.changes.chooseTurn', 'Changes from Turn')],
		['uncommitted', localize2('sessions.changes.uncommittedChanges', 'Uncommitted Changes')],
		['branch', localize2('sessions.changes.compareAgainst', 'Compare Against…')],
	] as const).entries()) {
		const id = `ash.sessions.changesScope.${scope}`;
		disposables.add(CommandsRegistry.register(id, (_accessor, arg) => {
			const group = getGroup(arg);
			if (group?.activePane instanceof SessionChangesEditor) return group.activePane.selectScope(scope, group.id);
			return undefined;
		}));
		disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsChangesScope, {
			command: { id, title, toggled: ChangesScopeContext.isEqualTo(scope) }, group: 'navigation', order,
		}));
	}

	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorHeaderLayout, {
		command: {
			id: TOGGLE_MULTI_DIFF_EDITOR_FILE_LIST_COMMAND_ID,
			title: getToggleMultiDiffEditorFileListTitle(),
			icon: Lxicon.listUnordered,
			toggled: MultiDiffEditorFileListEnabledContext.isEqualTo(true),
		},
		when: ContextKeyExpr.and(changesTool, MultiDiffEditorFileListAvailableContext.isEqualTo(true)),
		group: 'navigation',
		order: -1,
	}));
	return disposables;
}
