import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { NEW_FILE_TAB_COMMAND_ID } from '../../../common/sessionCommands.js';
import { localize2, localize } from '../../../../nls.js';
import '../../../../workbench/contrib/files/browser/files.contribution.js';
import '../../../../workbench/contrib/files/browser/media/explorerviewlet.css';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { KeybindingsRegistry } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService, type ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';

import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ASH_REMOTE_SCHEME } from '../../../../platform/remote/common/remote.js';
import { FocusedViewContext, IsSessionsWindowContext, ResourceSchemeContext, WorkspaceFolderCountContext } from '../../../../workbench/common/contextkeys.js';
import { resolveCommandsContext } from '../../../../workbench/browser/parts/editor/editorCommandsContext.js';
import { FileDownload } from '../../../../workbench/contrib/files/browser/fileImportExport.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { IViewsService } from '../../../../workbench/services/views/common/viewsService.js';
import { SESSIONS_FILES_VIEW_ID, SessionsExplorerView } from './filesView.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IEditorPartsService } from '../../../../workbench/browser/parts/editor/editorParts.js';
import { DesktopMainEditorPart } from '../../../browser/parts/desktopEditorPart.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation } from '../../../../workbench/common/views.js';

/** Installs Files on the document host while window commands keep the multi-window coordinator. */
class FilesViewContribution extends Disposable {
	constructor(
		@IEditorPartsService parts: IEditorPartsService,
	) {
		super();
		const editor = parts.mainPart;
		if (editor instanceof DesktopMainEditorPart) {
			this._register(editor.auxiliaryBar.registerViewContainer({
				id: SESSIONS_FILES_CONTAINER_ID, title: localize('sessions.files.title', 'Files'), location: ViewContainerLocation.AuxiliaryBar,
			}, [{
				id: SESSIONS_FILES_VIEW_ID, title: localize('sessions.files.title', 'Files'), canMoveView: false,
				ctorDescriptor: new SyncDescriptor(SessionsExplorerView),
			}]));
		}
	}
}

registerWorkbenchContribution('sessions.contrib.filesView', WorkbenchPhase.BlockStartup,
	services => services.get(IInstantiationService).createInstance(FilesViewContribution));

export const SESSIONS_FILES_CONTAINER_ID = 'workbench.sessions.auxiliaryBar.filesContainer';

registerAction2(class extends Action2 {
	constructor() { super({ id: SESSIONS_FILES_CONTAINER_ID, title: localize2('sessions.files.title', 'Files') }); }
	public override async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand(NEW_FILE_TAB_COMMAND_ID);
	}
});

// Keep the existing Files shortcut while its View is scoped to the Files Part.
KeybindingsRegistry.registerKeybindingRule({
	command: SESSIONS_FILES_CONTAINER_ID,
	keybinding: Keybinding.single(logicalKey('e', { primaryKey: true, shiftKey: true })),
	when: IsSessionsWindowContext.isEqualTo(true),
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'sessions.files.action.collapseExplorerFolders',
			title: localize2({ bundle: 'ash', key: 'sessions.files.collapseFolders' }, 'Collapse folders'),
			icon: Lxicon.chevronUp,
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
	when: ContextKeyExpr.and(IsSessionsWindowContext.isEqualTo(true), ContextKeyExpr.or(FocusedViewContext.isEqualTo(SESSIONS_FILES_VIEW_ID), ContextKeyExpr.has('sessionsFilesNavigationFocused'))),
	getProvider: accessor => {
		const view = accessor.get(IViewsService).getViewWithId(SESSIONS_FILES_VIEW_ID);
		if (!(view instanceof SessionsExplorerView)) { return undefined; }
		const focused = view.element.ownerDocument.activeElement;
		return new AccessibleContentProvider(
			AccessibleViewProviderId.Explorer,
			{ type: AccessibleViewType.Help },
			() => localize('sessions.files.navigationHelp', 'Opening Files shows its title and file tree without creating an editor tab. Opening a file creates its tab. Closing the last file returns to Files. The title bar Files button hides or restores the file editors and their attached tree together. Browser, Changes and Terminal remain independent. Toggle details changes only the attached tree.') + '\n' + localize('sessions.files.help', "Files\nThe Files EditorPart owns the file tree beside its document groups. Files, Changes, Browser and Terminal have independent EditorParts. Drag a tab to move its editor, or drag empty group title space to move a group. Alt-drag a title to move the tool workspace. Drop at a group edge to split, or in its center to combine tabs. With a header action focused, Alt+Shift+Arrow moves the group beside its local neighbor, or moves the tool workspace at the group boundary. Separators resize tools and groups. Toggle details hides or shows the file tree without closing documents. Toggle Files retains the tree, selection and unsaved edits. Use Ctrl or Command+Shift+E to focus Files, arrow keys to navigate, Enter to open a file, and Shift+F10 for file actions. Ctrl or Command+F searches the tree; Escape clears Find and restores focus. Alt+F2 reads the visible files. Files follows the selected session directory. Run Collapse folders in the Command Palette to collapse all folders. Press Shift+F10 for file actions and Alt+F2 to read the visible files. Remote files can be downloaded from the editor title. When there is no directory, Files shows an empty message. Use GitHub: Browse Repository Files in the Command Palette to choose a repository and branch, search filenames, and open read-only files without a local checkout. In GitHub file results, use Tab to reach Add to current Agent context, then Enter or Space to attach the captured file content without sending. Escape cancels a pending read."),
			() => { if (focused instanceof HTMLElement) { focused.focus(); } },
			AccessibilityVerbositySettingId.Explorer,
		);
	},
});
