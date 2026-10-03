import { localize2, localize } from '../../../../nls.js';
import '../../../../workbench/contrib/files/browser/files.contribution.js';
import '../../../../workbench/contrib/files/browser/media/explorerviewlet.css';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';
import { SessionsViewRegistry } from '../../../common/views.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ASH_REMOTE_SCHEME } from '../../../../platform/remote/common/remote.js';
import { FocusedViewContext, IsSessionsWindowContext, ResourceSchemeContext, WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { resolveCommandsContext } from '../../../../workbench/browser/parts/editor/editorCommandsContext.js';
import { FileDownload } from '../../../../workbench/contrib/files/browser/fileImportExport.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../workbench/services/views/browser/viewsService.js';
import { SESSIONS_FILES_EMPTY_VIEW_ID, SESSIONS_FILES_VIEW_ID, SessionsExplorerEmptyView, SessionsExplorerView } from './filesView.js';

export const SESSIONS_FILES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.filesContainer';

SessionsViewRegistry.registerStaticViewContainer({
	id: SESSIONS_FILES_CONTAINER_ID,
	title: 'Files',
	localizationKey: { bundle: 'ash', key: 'sessions.files.title' },
	location: ViewContainerLocation.AuxiliaryBar,
	icon: Lxicon.files,
	order: 0,
	isDefault: true,
});
SessionsViewRegistry.registerStaticViews(SESSIONS_FILES_CONTAINER_ID, [{
	id: SESSIONS_FILES_VIEW_ID,
	title: 'Files',
	localizationKey: { bundle: 'ash', key: 'sessions.files.title' },
	ctorDescriptor: new SyncDescriptor(SessionsExplorerView),
	when: ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0),
	canToggleVisibility: false,
}, {
	id: SESSIONS_FILES_EMPTY_VIEW_ID,
	title: 'Files',
	localizationKey: { bundle: 'ash', key: 'sessions.files.title' },
	ctorDescriptor: new SyncDescriptor(SessionsExplorerEmptyView),
	when: WorkspaceFolderCountContext.isEqualTo(0),
	canToggleVisibility: false,
}]);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SESSIONS_FILES_CONTAINER_ID,
			title: localize2({ bundle: 'ash', key: 'sessions.files.title' }, 'Files'),
			precondition: IsSessionsWindowContext.isEqualTo(true),
			f1: true,
			keybinding: { primary: Keybinding.single(logicalKey('e', { primaryKey: true, shiftKey: true })) },
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
		accessor.get(IViewsService).focusView(folders.length > 0 ? SESSIONS_FILES_VIEW_ID : SESSIONS_FILES_EMPTY_VIEW_ID);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.files.action.collapseExplorerFolders',
			title: localize2({ bundle: 'ash', key: 'sessions.files.collapseFolders' }, 'Collapse folders'),
			precondition: ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ContextKeyExpr.notEquals(WorkspaceFolderCountContext.key, 0)),
			f1: true,
		});
	}

	public override run(accessor: ServicesAccessor): void {
		const view = accessor.get(IViewsService).getViewWithId(SESSIONS_FILES_VIEW_ID);
		if (view instanceof SessionsExplorerView) {
			view.collapseAll();
		}
	}
});

export class DownloadRemoteFileAction extends Action2 {
	public static readonly ID = 'sessions.files.action.downloadRemoteFile';

	constructor() {
		const precondition = ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ResourceSchemeContext.isEqualTo(ASH_REMOTE_SCHEME));
		super({
			id: DownloadRemoteFileAction.ID,
			title: localize2({ bundle: 'ash', key: 'workbench.downloadFile' }, 'Download File...'),
			icon: Lxicon.download,
			precondition,
			menu: { id: MenuId.EditorTitle, group: 'navigation', when: precondition },
		});
	}

	public override async run(accessor: ServicesAccessor, ...args: readonly unknown[]): Promise<void> {
		const context = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
		const download = new FileDownload(accessor.get(IFileService));
		try {
			for (const { editors } of context.groupedEditors) {
				for (const editor of editors) {
					if (editor.resource.scheme === ASH_REMOTE_SCHEME) {
						await download.download(editor.resource, document);
					}
				}
			}
		} catch (error) {
			accessor.get(INotificationService).error(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
}

registerAction2(DownloadRemoteFileAction);

AccessibleViewRegistry.register({
	type: AccessibleViewType.Help,
	name: 'sessionsFilesHelp',
	priority: 110,
	when: ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ContextKeyExpr.or(FocusedViewContext.isEqualTo(SESSIONS_FILES_VIEW_ID), FocusedViewContext.isEqualTo(SESSIONS_FILES_EMPTY_VIEW_ID))),
	getProvider: accessor => {
		const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
		const view = accessor.get(IViewsService).getViewWithId(folders.length > 0 ? SESSIONS_FILES_VIEW_ID : SESSIONS_FILES_EMPTY_VIEW_ID);
		if (!(view instanceof SessionsExplorerView || view instanceof SessionsExplorerEmptyView)) { return undefined; }
		const focused = view.element.ownerDocument.activeElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Explorer,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.files.help', 'Files\nFiles follow the selected session directory. Press Ctrl or Command+Shift+E to focus Files. Use the arrow keys to move through files and folders, Right Arrow to expand, Left Arrow to collapse, and Enter to open a file. Use Collapse folders in the Files toolbar to collapse all folders. Press Shift+F10 for file actions and Alt+F2 to read the visible files. Remote files can be downloaded from the editor title. When there is no directory, Files shows an empty message.'),
			() => { if (focused instanceof HTMLElement) { focused.focus(); } },
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
